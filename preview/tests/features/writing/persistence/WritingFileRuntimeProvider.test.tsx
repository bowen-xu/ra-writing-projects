// @vitest-environment happy-dom
import {act, createContext, useContext, useState, type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createAppRuntime} from "@research-assistant/writing-projects-preview/create-app-runtime";
import {selectAppRuntime, type AppRuntime} from "@research-assistant/workbench-preview/app-runtime";
import {WritingFileRuntimeProvider, useWritingFileRuntime, useWritingProjectFiles} from "@research-assistant/writing-projects-preview/writing-file-runtime-provider";
import type {WritingFileRuntimeStore} from "@research-assistant/writing-projects-preview/writing-file-runtime-store";
import {getWritingGateway} from "@research-assistant/writing-projects-preview/index";
import {WorkspaceTabsProvider} from "@research-assistant/workbench-preview/workbench-c5927e";
import {AgentDraftProvider} from "@research-assistant/workbench-preview/agent-draft-provider";
import {AgentQueueProvider} from "@research-assistant/workbench-preview/agent-queue-provider";
import {AgentSteeringProvider} from "@research-assistant/workbench-preview/agent-steering-provider";
import {WritingConversationSession} from "@research-assistant/writing-projects-preview/writing-conversation-session";
import {notify} from "@research-assistant/workbench-preview/feedback";
import {useWritingDocuments} from "@research-assistant/writing-projects-preview/use-writing-documents";
import {getWritingCheckpointGateway} from "@research-assistant/writing-projects-preview/writing-checkpoint-gateway";
import {undo} from "@codemirror/commands";
import type {PluginWritingRuntimeBinding, PluginWritingRuntimeProps} from "@research-assistant/workbench-sdk/activation";
import {useWritingRuntimeAdmission} from "@research-assistant/writing-projects-preview/writing-runtime-admission";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let runtime: AppRuntime, root: ReturnType<typeof createRoot>, host: HTMLDivElement;
let owner: WritingFileRuntimeStore;
let originalLocks: PropertyDescriptor | undefined;
beforeEach(async () => {
  localStorage.clear();
  vi.spyOn(notify, "error").mockReturnValue("test-error");
  originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", {configurable: true, value: {request: async (name: string, options: unknown, callback?: (lock: object | null) => Promise<unknown>) => {
    const run = typeof options === "function" ? options as (lock: object | null) => Promise<unknown> : callback;
    if (!run) throw new Error("Missing lock callback");
    if (held.has(name)) return run(null);
    held.add(name); try {return await run({name});} finally {held.delete(name);}
  }}});
  selectAppRuntime({mode: "browser", storage: localStorage, gateways: {}, dispose() {}});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.4\nsynthetic sample", {status: 200})));
  runtime = await createAppRuntime("?preview=app", localStorage);
  runtime.preview?.configure({delayMs: 0, nextFailure: null});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove(); runtime?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks); else Reflect.deleteProperty(navigator, "locks");
  selectAppRuntime({mode: "browser", storage: localStorage, gateways: {}, dispose() {}});
});
function Probe({id}: {readonly id: string}) {
  owner = useWritingFileRuntime(); useWritingProjectFiles(id);
  return null;
}
async function fixture() {
  const pairs: [string, string][] = JSON.parse(runtime.storage.getItem("agent-bindings") ?? "[]");
  const [conversationId, manuscriptId] = pairs[0]!;
  const project = (await getWritingGateway().listManuscripts()).find(item => item.id === manuscriptId)!;
  return {conversationId, manuscriptId, project};
}

it("shares the runtime's original store at separate workspace and session positions while retaining local context", async () => {
  const Local = createContext("outside"), observed: {owner: WritingFileRuntimeStore; label: string; disabled: boolean}[] = [];
  let binding: PluginWritingRuntimeBinding | undefined;
  let disabled = false;
  const listeners = new Set<() => void>();
  const lifecycle = {isDisabled: () => disabled, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => {listeners.delete(listener);};
  }};
  function Probe() {
    observed.push({owner: useWritingFileRuntime(), label: useContext(Local), disabled: useWritingRuntimeAdmission().disabled});
    return null;
  }
  function Host() {
    const [ready, setReady] = useState<PluginWritingRuntimeBinding>();
    const [onReady] = useState<PluginWritingRuntimeProps["onReady"]>(() => (value: PluginWritingRuntimeBinding) => {
      binding = value; setReady(value);
      return () => {setReady(current => current === value ? undefined : current);};
    });
    const Scope = ready?.Scope;
    function at(label: string): ReactNode {
      return <Local.Provider value={label}>{Scope && <Scope><Probe/></Scope>}</Local.Provider>;
    }
    return <WorkspaceTabsProvider><WritingFileRuntimeProvider runtime={{...lifecycle, onReady}}>{null}</WritingFileRuntimeProvider>
      {at("workspace")}{at("session")}</WorkspaceTabsProvider>;
  }
  await act(async () => root.render(<Host/>));
  expect(observed.map(value => value.label)).toEqual(["workspace", "session"]);
  expect(observed[0]!.owner).toBe(observed[1]!.owner);
  expect(await binding!.prepareClose()).toBe(true);
  const original = observed[0]!.owner;
  await act(async () => {disabled = true; for (const listener of listeners) listener();});
  expect(observed.slice(-2).map(value => value.disabled)).toEqual([true, true]);
  expect(observed.slice(-2).every(value => value.owner === original)).toBe(true);
  let release: (() => void) | undefined;
  try {
    await act(async () => {release = await original.access.acquire();});
    expect(await binding!.prepareClose()).toBe(false);
  } finally {await act(async () => release?.());}
  expect(await binding!.prepareClose()).toBe(true);
});

it("retains one file session and its review after chat observers leave, without mounting an editor or tabs", async () => {
  const {manuscriptId} = await fixture();
  const gateway = getWritingGateway(), checkpointGateway = getWritingCheckpointGateway();
  let documents: ReturnType<typeof useWritingDocuments> | undefined;
  function ProjectView() {
    documents = useWritingDocuments({identity: "manual-open", manuscriptId, gateway, checkpointGateway, initialOpenPaths: ["main.tex"]});
    return null;
  }
  const render = async (show: boolean, projectView = false) => act(async () => root.render(<WritingFileRuntimeProvider>{show && <Probe id={manuscriptId}/>} {projectView && <ProjectView/>}</WritingFileRuntimeProvider>));
  await render(true);
  await vi.waitFor(() => expect(owner.getApplications(manuscriptId)?.filesReady).toBe(true));
  await vi.waitFor(async () => {await act(async () => {await Promise.resolve();}); expect(owner.getApplications(manuscriptId)?.agentDelivery.pending, JSON.stringify(owner.getApplications(manuscriptId)?.agentDelivery.entries.map(entry=>({status:entry.status,stage:entry.failureStage,application:entry.application})))).toBe(false);}, {timeout: 1800});
  await vi.waitFor(() => expect(owner.access.isExclusive()).toBe(false));
  const disk = await owner.access.gateway.readFile(manuscriptId, "main.tex");
  await act(async () => owner.checkpoints.open(manuscriptId, disk));
  const file = owner.files.get({manuscriptId, relativePath: "main.tex"})!;
  await act(async () => {
    file.applyAgent("retained-candidate", file.read().version, `${file.read().content}\n% retained candidate`);
    await owner.checkpoints.flush(file.identity);
  });
  const before = file.read();
  await render(false); await render(true);
  expect(owner.files.get(file.identity)).toBe(file);
  expect(file.read()).toEqual(before);
  expect(file.pending).toBe(true);
  await render(true, true);
  await vi.waitFor(() => expect(documents?.ready).toBe(true));
  expect(documents?.files).toBe(owner.files);
  expect(documents?.files.get(file.identity)).toBe(file);
  expect(file.read()).toEqual(before);
  let release: (() => void) | undefined;
  try {
    await act(async () => {release = await owner.access.acquire();});
    expect(documents?.ready).toBe(true);
    expect(documents?.files.get(file.identity)).toBe(file);
  } finally {await act(async () => release?.());}
  await act(async () => {
    file.resolveAll("keep"); expect(file.pending).toBe(false);
    expect(undo({get state() {return file.state;}, dispatch: transaction => file.accept([transaction])})).toBe(true);
    await owner.checkpoints.flush(file.identity);
  });
  expect(file.pending).toBe(true);
  expect(file.read().content).toBe(before.content);
  expect(file.read().reviewBaseline).toBe(before.reviewBaseline);
  expect(host.querySelector(".cm-editor,[role=tab],.writing-workspace")).toBeNull();
});

it("continues a historical writing conversation and receives file edits without a project page", async () => {
  const {conversationId, manuscriptId, project} = await fixture();
  vi.useFakeTimers();
  const gateway = runtime.gateways.agentSubmissionGateway!;
  const start = vi.fn(gateway.startWriting), prepare = vi.fn(gateway.prepareWriting);
  selectAppRuntime({...runtime, gateways: {...runtime.gateways, agentSubmissionGateway: new Proxy(gateway, {get: (target, property) => property === "startWriting" ? start : property === "prepareWriting" ? prepare : Reflect.get(target, property)})}});
  const render = async (show: boolean) => act(async () => root.render(<WorkspaceTabsProvider><AgentDraftProvider><AgentQueueProvider><AgentSteeringProvider>
    <WritingFileRuntimeProvider><Probe id={manuscriptId}/>{show && <WritingConversationSession id={conversationId}
      directory={{manuscriptId, title: project.title, path: manuscriptId}} title="History" archived={false}
      open onOpenChange={() => undefined} headerControls={null} onRenamed={() => undefined}/>}</WritingFileRuntimeProvider>
  </AgentSteeringProvider></AgentQueueProvider></AgentDraftProvider></WorkspaceTabsProvider>));
  await render(true);
  await vi.waitFor(() => expect(owner.getApplications(manuscriptId)?.filesReady).toBe(true));
  await vi.waitFor(async () => {await act(async () => {await Promise.resolve();}); expect(owner.getApplications(manuscriptId)?.agentDelivery.pending, JSON.stringify(owner.getApplications(manuscriptId)?.agentDelivery.entries.map(entry=>({status:entry.status,stage:entry.failureStage,application:entry.application})))).toBe(false);}, {timeout: 1800});
  await vi.waitFor(() => expect(owner.access.isExclusive()).toBe(false));
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "继续修改摘要");
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
  await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(false));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click());
  await vi.waitFor(() => expect(start, JSON.stringify(vi.mocked(notify.error).mock.calls)).toHaveBeenCalledOnce());
  const captured = prepare.mock.calls[0]![0].context.files.find(file => file.relativePath === "main.tex");
  expect(captured?.buffer?.text).toBe(owner.files.get({manuscriptId, relativePath: "main.tex"})?.read().content);
  expect(owner.getApplications(manuscriptId)?.agentDelivery.entries.length).toBeGreaterThan(0);
  await render(false);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  await vi.waitFor(() => expect(owner.files.get({manuscriptId, relativePath: "main.tex"})?.pending).toBe(true), {timeout: 8000});
  await act(async () => owner.saves.flushAll());
  await vi.waitFor(async () => {await act(async () => {await Promise.resolve();}); expect(owner.getApplications(manuscriptId)?.agentDelivery.pending, JSON.stringify(owner.getApplications(manuscriptId)?.agentDelivery.entries.map(entry=>({status:entry.status,stage:entry.failureStage,application:entry.application})))).toBe(false);}, {timeout: 1800});
  await vi.waitFor(() => expect(owner.access.isExclusive()).toBe(false));
  const file = owner.files.get({manuscriptId, relativePath: "main.tex"})!;
  expect((await owner.access.gateway.readFile(manuscriptId, "main.tex")).content).toBe(file.read().content);
  await render(true);
  await vi.waitFor(() => expect([...host.querySelectorAll(".writing-agent-message.user")].at(-1)?.textContent).toContain("继续修改摘要"));
  expect(host.querySelector(".cm-editor,[role=tab],.writing-workspace")).toBeNull();
});
