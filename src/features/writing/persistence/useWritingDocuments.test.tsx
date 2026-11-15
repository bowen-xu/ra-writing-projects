/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {EditorView} from "@codemirror/view";
import {getOriginalDoc} from "@codemirror/merge";
import {afterEach, expect, it, vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {WritingEditorPane} from "../editor/WritingEditorPane";
import {WritingDiffDemoStorage} from "../../../../../../apps/web/src/app/previews/agent/WritingDiffDemoStorage";
import {WritingDiffDemoAgentStorage} from "../../../../../../apps/web/src/app/previews/agent/WritingDiffDemoAgentStorage";
import {createWritingDiffDemoGateway} from "../../../../../../apps/web/src/app/previews/agent/writingDiffDemoGateway";
import {useWritingDocuments, type WritingDocumentsOptions} from "./useWritingDocuments";
import {NativeCanvasEditor} from "../../../../../../apps/web/src/app/previews/agent/NativeCanvasEditor";

vi.mock("@tauri-apps/api/core", () => ({isTauri: () => false, invoke: vi.fn(async () => {throw new Error("Unexpected desktop I/O");})}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); expect(invoke).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function fixture(initial = true) {
  const manuscriptId = crypto.randomUUID(), scope = {manuscriptId, conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID()};
  const admission = {scope, turnId: crypto.randomUUID()}, changes = [{path: "main.tex", kind: "modified" as const,
    before: "Original evidence 80%\n", after: "Candidate evidence 85%\n", additions: 1, deletions: 1}];
  const storage = new WritingDiffDemoStorage(manuscriptId, changes), agent = new WritingDiffDemoAgentStorage(storage, initial ? {admission, changes} : undefined);
  const gateway = createWritingDiffDemoGateway(storage, manuscriptId);
  const options: WritingDocumentsOptions = {identity: crypto.randomUUID(), manuscriptId, gateway, checkpointGateway: storage.checkpoints,
    agentGateways: agent.gateways, initialOpenPaths: ["main.tex"], persistWorkspaceSession: false};
  cleanups.push(async () => agent.history.dispose());
  return {scope, admission, changes, storage, agent, gateway, options};
}
async function settled(assertion: () => void) {await vi.waitFor(async () => {await act(async () => Promise.resolve()); assertion();});}
async function mount(options: WritingDocumentsOptions, {nativeEditor = false}: {readonly nativeEditor?: boolean} = {}) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let documents!: ReturnType<typeof useWritingDocuments>, active = true;
  function Harness({value, tabsActive = true}: {readonly value: WritingDocumentsOptions; readonly tabsActive?: boolean}) {
    documents = useWritingDocuments(value);
    if (nativeEditor) return <NativeCanvasEditor manuscriptId={value.manuscriptId} documents={documents} blocked={false} tabsActive={tabsActive}/>;
    return <>{documents.recoveryFeedback}{documents.ready && <WritingEditorPane activeManuscriptId={value.manuscriptId}
      activePath={documents.activePath} content={documents.content} fileSessions={documents.files} openPaths={documents.openPaths}
      onEditorSessionReady={documents.setEditorPort} onChange={documents.onChange} onSelect={documents.select}
      saveState={documents.saveState(documents.activePath ?? "")} completionData={{citationKeys: [], files: [], labels: []}}
      cursorOffset={0} diagnostics={[]} focusRequest={undefined} insertionRequest={undefined}
      preferences={{fontSize: 14, lineWrapping: true, showLineNumbers: true, tabSize: 2}}
      onClose={documents.close} onCursorChange={() => {}} onCompile={() => {}} onOpenCommands={() => {}} onInsertCitation={() => {}}
      codeCheckEnabled={false} hasCodeCheckErrors={false} onCodeCheckResult={() => {}}
      syncActions={{forward: () => {}, backward: () => {}, forwardDisabled: undefined, backwardDisabled: undefined}}/>}</>;
  }
  const render = async (value: WritingDocumentsOptions, view: {readonly tabsActive?: boolean} = {}) => act(async () => root.render(<Harness value={value} {...view}/>));
  await render(options);
  const close = async () => {if (active) {active = false; await act(async () => root.unmount()); host.remove();}};
  cleanups.push(close);
  return {get: () => documents, host, close, render, view: () => {
    const element = host.querySelector<HTMLElement>(".cm-editor"); if (!element) throw new Error("Missing production editor");
    const view = EditorView.findFromDOM(element); if (!view) throw new Error("Missing production editor owner"); return view;
  }};
}

it("shares production sessions, proposal application, reliable saves and review baseline with injected I/O and no chat owner", async () => {
  const f = fixture(), saveSession = vi.spyOn(f.gateway, "saveSession"), h = await mount(f.options);
  await settled(() => expect(h.get().files.all().map(file => file.readOperations().length)).toEqual([1]));
  await settled(() => expect(h.get().agentDelivery.pending).toBe(false));
  const original = h.get().files, file = original.get({manuscriptId: f.scope.manuscriptId, relativePath: "main.tex"})!;
  expect(h.view().state).toBe(file.state);
  expect(file.read()).toMatchObject({content: f.changes[0]!.after, reviewBaseline: f.changes[0]!.before});
  expect((await f.storage.files.readFile(f.scope.manuscriptId, "main.tex")).content).toBe(f.changes[0]!.after);
  const checkpoint = (await f.storage.checkpoints.list(f.scope.manuscriptId))[0]!.checkpoint;
  expect(checkpoint.editorReceipt?.operationId).toBe(file.readOperations()[0]!.operationId);
  expect(checkpoint.reviewBaseline).toBe(f.changes[0]!.before);
  await act(async () => {h.get().agentDelivery.register(f.admission); h.get().agentDelivery.register(f.admission);});
  await h.render({...f.options, initialOpenPaths: ["ignored.tex"]});
  expect(h.get().files).toBe(original); expect(h.get().activePath).toBe("main.tex"); expect(file.readOperations()).toHaveLength(1);
  expect(saveSession).not.toHaveBeenCalled();
});

it("blocks new delivery while close drains the existing tail and original acknowledgement remains reachable", async () => {
  const f = fixture(), gate = deferred<void>(), original = f.agent.gateways.delivery.deliveries.acknowledge;
  let entered = false;
  const acknowledge = vi.spyOn(f.agent.gateways.delivery.deliveries, "acknowledge").mockImplementation(async request => {
    entered = true; await gate.promise; return original(request);
  });
  const h = await mount(f.options); await settled(() => expect(entered).toBe(true));
  const file = h.get().files.all()[0]!, port = file.applicationPort, view = h.view();
  await h.render({...f.options, admissionsBlocked: true});
  let finished = false, closing!: Promise<boolean>;
  await act(async () => {closing = h.get().prepareClose().then(result => {finished = true; return result;}); await Promise.resolve();});
  const application = vi.spyOn(f.agent.gateways.application.applications, "execute");
  const next = {scope: {...f.scope, conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID()}, turnId: crypto.randomUUID()};
  const changes = [{...f.changes[0]!, before: f.changes[0]!.after, after: "Next candidate 90%\n"}];
  await act(async () => {await f.agent.complete(next, changes); h.get().agentDelivery.register(next);});
  await settled(() => expect(h.get().agentDelivery.entries.some(entry => entry.turnId === next.turnId && entry.status === "waiting")).toBe(true));
  expect(finished).toBe(false);
  expect(h.get().agentDelivery.pending).toBe(true); expect(h.view()).toBe(view); expect(file.applicationPort).toBe(port);
  await act(async () => {gate.resolve(); expect(await closing).toBe(true);});
  expect(finished).toBe(true); expect(h.get().agentDelivery.pending).toBe(true);
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(f.admission);
  expect(application).not.toHaveBeenCalled(); expect(view.state.doc.toString()).toBe(f.changes[0]!.after);
  expect(getOriginalDoc(view.state).toString()).toBe(f.changes[0]!.before);
  await h.render(f.options); await settled(() => expect(h.get().agentDelivery.pending).toBe(false));
  expect(file.read().content).toBe(changes[0]!.after); expect(acknowledge).toHaveBeenCalledTimes(2);
});

it("blocks replacement when preservation fails and rebuilds the same saved candidate and later input without reapplying it", async () => {
  const f = fixture(), h = await mount(f.options); await settled(() => expect(h.get().agentDelivery.pending).toBe(false));
  await settled(() => expect(h.get().files.all()[0]?.readOperations()).toHaveLength(1));
  const view = h.view(); await act(async () => view.dispatch({changes: {from: 0, insert: "Later input\n"}, userEvent: "input.type"}));
  f.storage.fault = "checkpoint";
  await act(async () => expect(await h.get().prepareClose()).toBe(false));
  expect(h.view()).toBe(view); expect(view.state.doc.toString()).toBe("Later input\n" + f.changes[0]!.after);
  f.storage.fault = "none"; await act(async () => expect(await h.get().prepareClose()).toBe(true));
  const before = h.get().files.all()[0]!.read(), original = h.get();
  await h.close();
  const application = vi.spyOn(f.agent.gateways.application.applications, "execute");
  const reopened = await mount({...f.options, identity: crypto.randomUUID()}); await settled(() => expect(reopened.get().ready).toBe(true));
  expect(reopened.get().files).not.toBe(original.files); expect(reopened.get().files.all()[0]!.read()).toEqual(before);
  expect(reopened.get().files.all()[0]!.readOperations()).toHaveLength(1); expect(application).not.toHaveBeenCalled();
});

it("does not let a late file load or stale host callbacks touch a replacement gateway owner", async () => {
  const first = fixture(false), next = fixture(false), gate = deferred<Awaited<ReturnType<typeof first.gateway.readFile>>>();
  const read = first.gateway.readFile;
  vi.spyOn(first.gateway, "readFile").mockImplementationOnce(async (...args) => {await gate.promise; return read(...args);});
  const h = await mount(first.options), original = h.get();
  await h.render(next.options); await settled(() => expect(h.get().ready).toBe(true));
  const replacement = h.get().files, readNext = vi.spyOn(next.gateway, "readFile"), snapshot = h.get().readEditorSnapshot();
  await act(async () => {await original.select("main.tex"); await original.close("main.tex"); original.onChange("stale"); original.setEditorPort(null); expect(await original.prepareClose()).toBe(false);
    gate.resolve(await read(first.scope.manuscriptId, "main.tex")); await Promise.resolve();});
  expect(h.get().files).toBe(replacement); expect(h.get().readEditorSnapshot()).toEqual(snapshot); expect(readNext).not.toHaveBeenCalled();
  expect(h.get().content).toBe(next.changes[0]!.before);
});

it("uses production navigation save gates before switching or closing and retains the closed file owner", async () => {
  const f = fixture(false); await f.storage.files.createFile(f.scope.manuscriptId, "second.tex", "Second source\n");
  const h = await mount({...f.options, initialOpenPaths: ["main.tex", "second.tex"]});
  await settled(() => expect(h.get().editorReady).toBe(true));
  const files = h.get().files, main = files.get({manuscriptId: f.scope.manuscriptId, relativePath: "main.tex"})!, view = h.view();
  const save = vi.spyOn(f.gateway, "saveFile"), read = vi.spyOn(f.gateway, "readFile");
  vi.stubGlobal("confirm", vi.fn(() => true)); f.storage.fault = "file";
  await act(async () => view.dispatch({changes: {from: 0, insert: "Unsent editor change\n"}, userEvent: "input.type"}));
  await act(async () => {await h.get().select("second.tex"); await h.get().close("main.tex");});
  expect(save).toHaveBeenCalledTimes(2);
  // Save recovery may inspect the current disk candidate, but cannot open the requested tab.
  expect(read).not.toHaveBeenCalledWith(f.scope.manuscriptId, "second.tex");
  expect(h.get().activePath).toBe("main.tex"); expect(h.get().openPaths).toEqual(["main.tex", "second.tex"]);
  expect(h.view()).toBe(view); expect(main.read().content).toBe("Unsent editor change\n" + f.changes[0]!.before);
  f.storage.fault = "none"; await act(async () => h.get().close("main.tex"));
  await settled(() => expect(h.get().activePath).toBe("second.tex"));
  expect(h.get().openPaths).toEqual(["second.tex"]); expect(h.get().files).toBe(files);
  expect(files.get({manuscriptId: f.scope.manuscriptId, relativePath: "main.tex"})).toBe(main);
  expect(h.get().readFileBuffers().find(buffer => buffer.path === "main.tex")?.text).toBe(main.read().content);
  expect((await f.storage.files.readFile(f.scope.manuscriptId, "main.tex")).content).toBe(main.read().content);
  await act(async () => h.get().select("main.tex")); await settled(() => expect(h.get().activePath).toBe("main.tex"));
  expect(h.get().files.get({manuscriptId: f.scope.manuscriptId, relativePath: "main.tex"})).toBe(main);
});

it("does not save, switch or close files when the existing owner blocks new admissions", async () => {
  const f = fixture(false); await f.storage.files.createFile(f.scope.manuscriptId, "second.tex", "Second source\n");
  const options = {...f.options, initialOpenPaths: ["main.tex", "second.tex"]}, h = await mount(options);
  await settled(() => expect(h.get().editorReady).toBe(true));
  const original = h.get().files, save = vi.spyOn(f.gateway, "saveFile"), read = vi.spyOn(f.gateway, "readFile");
  await h.render({...options, admissionsBlocked: true});
  await act(async () => {await h.get().select("second.tex"); await h.get().close("main.tex"); await h.get().close("second.tex");});
  expect(save).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(h.get().files).toBe(original);
  expect(h.get().activePath).toBe("main.tex"); expect(h.get().openPaths).toEqual(["main.tex", "second.tex"]);
});

it("delivers and settles the original acknowledgement headlessly after closing the last visible source tab", async () => {
  const f = fixture(false), h = await mount(f.options, {nativeEditor: true});
  await settled(() => expect(h.get().editorReady).toBe(true));
  const files = h.get().files, file = files.all()[0]!;
  const apply = vi.spyOn(file.applicationPort, "apply"), acknowledge = vi.spyOn(f.agent.gateways.delivery.deliveries, "acknowledge");
  await act(async () => h.get().close("main.tex"));
  await settled(() => {expect(h.get().activePath).toBeUndefined(); expect(h.get().editorReady).toBe(false);});
  f.agent.loseAcknowledgmentOnce = true;
  await act(async () => {await f.agent.complete(f.admission, f.changes); h.get().agentDelivery.register(f.admission);});
  await settled(() => expect(h.get().agentDelivery.entries).toMatchObject([{status: "error", failureStage: "acknowledgement"}]));
  expect(h.get().openPaths).toEqual([]); expect(h.get().files).toBe(files);
  expect(file.read()).toMatchObject({content: f.changes[0]!.after, reviewBaseline: f.changes[0]!.before});
  expect(file.readOperations()).toHaveLength(1); expect(apply).toHaveBeenCalledTimes(1);
  expect((await f.storage.files.readFile(f.scope.manuscriptId, "main.tex")).content).toBe(f.changes[0]!.after);
  const retry = [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重试确认记录")!;
  expect(retry.disabled).toBe(false);
  await act(async () => retry.click());
  await settled(() => expect(h.get().agentDelivery.pending).toBe(false));
  expect(acknowledge).toHaveBeenCalledTimes(2); expect(apply).toHaveBeenCalledTimes(1);
  expect(h.get().editorReady).toBe(false); expect(h.get().activePath).toBeUndefined();
});

it("declares unavailable Native citation ports on the production editor control", async () => {
  const f = fixture(false), h = await mount(f.options, {nativeEditor: true});
  await settled(() => expect(h.get().editorReady).toBe(true));
  const insert = h.host.querySelector<HTMLButtonElement>('[aria-label="插入引用"]')!;
  expect(insert.disabled).toBe(true);
  expect(insert.getAttribute("aria-description")).toContain("尚未接入受管引用与文献库端口");
  const snapshot = h.get().readEditorSnapshot(); await act(async () => insert.click());
  expect(h.get().readEditorSnapshot()).toEqual(snapshot);
});

it("keeps the production editor and file owner alive while a text tab hides the source workspace", async () => {
  const f = fixture(false), h = await mount(f.options, {nativeEditor: true});
  await settled(() => expect(h.get().editorReady).toBe(true));
  const files = h.get().files, file = files.all()[0]!, port = file.applicationPort, view = h.view();
  const section = h.host.querySelector<HTMLElement>('[aria-label="稿件文件交付与编辑器"]')!;
  await h.render(f.options, {tabsActive: false});
  expect(section.hidden).toBe(true); expect(h.host.querySelector<HTMLElement>(".writing-retained-source")?.hidden).toBe(true);
  expect(h.view()).toBe(view); expect(h.get().files).toBe(files); expect(file.applicationPort).toBe(port);
  await act(async () => {await f.agent.complete(f.admission, f.changes); h.get().agentDelivery.register(f.admission);});
  await settled(() => expect(file.readOperations()).toHaveLength(1));
  await settled(() => expect(h.get().agentDelivery.pending).toBe(false));
  expect(file.read()).toMatchObject({content: f.changes[0]!.after, reviewBaseline: f.changes[0]!.before});
  await h.render(f.options, {tabsActive: true});
  expect(section.hidden).toBe(false); expect(h.host.querySelector<HTMLElement>(".writing-retained-source")?.hidden).toBe(false);
  expect(h.view()).toBe(view); expect(h.view().state).toBe(file.state); expect(h.get().files).toBe(files);
});
