/** @vitest-environment happy-dom */
import { mocks, retrieval, workspace, id, submissionContext, WritingAgentRuntimePanel } from "./WritingAgentRuntimePanel.test-harness.tsx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { notify } from "@research-assistant/workbench-preview/feedback";
import * as coreEnvironment from "@research-assistant/workbench-preview/runtime-environment";
import {NATIVE_PREVIEW_OWNER_CAPABILITY} from "@research-assistant/workbench-preview/preview-owner";

it("previews global concept retrieval before binding it to the writing submission", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.prepareWriting.mockImplementation(async (request) => ({
    schemaVersion: 1, conversationId: id, requestId: request.requestId, manuscriptId: id, turnId: id,
    contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null },
      context: [{ sourceId: "source", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: JSON.stringify({ manuscriptId: id }), text: "source" }] },
  }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Find related work"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="添加上下文和工具"]')?.click());
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="概念网络检索"]')!;
    await act(async () => { toggle.click(); });
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(retrieval.preview).toHaveBeenCalledWith({ clientRequestId: expect.any(String), query: "Find related work" });
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    expect(container.textContent).toContain("确认来源并发送");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "确认来源并发送")!.click());
    expect(mocks.prepareWriting.mock.calls.at(-1)?.[0].retrieval).toEqual({ traceId: "trace-writing", query: "Find related work" });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("retains a retrieval preview when switching conversations and confirms it after returning", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const second = "22222222-2222-4222-8222-222222222222";
  let resolvePreview!: (value: Awaited<ReturnType<typeof retrieval.preview>>) => void;
  retrieval.preview.mockImplementationOnce(() => new Promise(resolve => { resolvePreview = resolve; }));
  mocks.prepareWriting.mockImplementation(async (request) => ({
    schemaVersion: 1, conversationId: id, requestId: request.requestId, manuscriptId: id, turnId: id,
    contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null },
      context: [{ sourceId: "source", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: null, text: "source" }] },
  }));
  mocks.startWriting.mockResolvedValue({ schemaVersion: 1, conversationId: id, requestId: id, turnId: id, alreadyStarted: false, outcome: null });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (conversationId: string) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={conversationId} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
    files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
    messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />);
  try {
    await act(async () => render(id));
    const textarea = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Find related work"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="添加上下文和工具"]')?.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="概念网络检索"]')?.click());
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(container.textContent).toContain("正在检索已接受的概念和来源");
    await act(async () => render(second));
    resolvePreview({ traceId: "trace-writing", semanticStatus: "used", seeds: [], edges: [], sources: [], selectedSourceCount: 0, externalPaperCount: 0, contextSha256: "a".repeat(64), expiresAt: "later" });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain("确认来源并发送");
    await act(async () => render(id));
    expect(container.textContent).toContain("确认来源并发送");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "确认来源并发送")!.click());
    expect(mocks.prepareWriting.mock.calls.at(-1)?.[0].retrieval).toEqual({ traceId: "trace-writing", query: "Find related work" });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("returning a committed preparation to editing retains the consumed trace and requires a fresh retrieval selection for the new R", async () => {
  vi.clearAllMocks();
  const traces = [crypto.randomUUID(), crypto.randomUUID()], consumed = new Set<string>(); let selection = 0;
  retrieval.preview.mockImplementation(async () => ({traceId: traces[selection++]!, semanticStatus: "used", seeds: [], edges: [], sources: [],
    selectedSourceCount: 0, externalPaperCount: 0, contextSha256: "a".repeat(64), expiresAt: "later"}));
  mocks.prepareWriting.mockImplementation(async request => {
    const trace = request.retrieval.traceId; if (consumed.has(trace)) throw "conflict"; consumed.add(trace);
    return {schemaVersion: 1, conversationId: id, manuscriptId: id, requestId: request.requestId, contextSnapshotId: id, turnId: id,
      input: {text: request.text, model: {providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null}, reasoningEffort: null, context: submissionContext(request)}};
  });
  mocks.startWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null}));
  workspace.prepare.mockRejectedValueOnce("denied");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const send = () => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  const confirm = () => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "确认来源并发送")!.click());
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
      files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined}/>));
    const input = host.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Find related work"); input.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="添加上下文和工具"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="概念网络检索"]')!.click());
    await send(); await confirm();
    expect(consumed).toEqual(new Set([traces[0]])); expect(mocks.startWriting).not.toHaveBeenCalled();
    const first = mocks.prepareWriting.mock.calls[0]![0], notice = vi.mocked(notify.error).mock.calls.at(-1)?.[1];
    expect(notice?.dismissible).toBe(false);
    await act(async () => notice!.actions!.find(action => action.label === "返回编辑")!.onClick());
    expect(consumed).toEqual(new Set([traces[0]])); expect(mocks.prepareWriting).toHaveBeenCalledOnce(); expect(input.value).toBe("Find related work");
    await send(); expect(retrieval.preview).toHaveBeenCalledTimes(2); expect(mocks.prepareWriting).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("确认来源并发送"); await confirm();
    const second = mocks.prepareWriting.mock.calls[1]![0]; expect(second.requestId).not.toBe(first.requestId);
    expect(first.retrieval).toEqual({traceId: traces[0], query: "Find related work"}); expect(second.retrieval).toEqual({traceId: traces[1], query: "Find related work"});
    expect(consumed).toEqual(new Set(traces)); expect(mocks.startWriting).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId: second.requestId}));
  } finally {await act(async () => root.unmount()); host.remove();}
});

it("checks current owner-intent support when confirming a retrieval prepared before a preview reset", async () => {
  vi.clearAllMocks();
  const environment = coreEnvironment.getRuntimeEnvironment();
  const readEnvironment = vi.spyOn(coreEnvironment, "getRuntimeEnvironment").mockReturnValue(environment);
  const previous = Object.getOwnPropertyDescriptor(environment, "nativeAgentPreview");
  let bootstrap = {generation: "synthetic-before", supported: [] as string[]};
  const readBootstrap = vi.fn(() => bootstrap);
  Object.defineProperty(environment, "nativeAgentPreview", {configurable: true, value: {get bootstrap() {return readBootstrap();}}});
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
      files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Find related work");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="添加上下文和工具"]')?.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="概念网络检索"]')!.click());
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(retrieval.preview).toHaveBeenCalledOnce();
    const confirm = [...container.querySelectorAll("button")].find(button => button.textContent === "确认来源并发送")!;
    const previousReads = readBootstrap.mock.calls.length;
    bootstrap = {generation: "synthetic-after", supported: [NATIVE_PREVIEW_OWNER_CAPABILITY]};
    await act(async () => confirm.click());
    expect(readBootstrap.mock.calls.length).toBeGreaterThan(previousReads);
    expect(notify.error).toHaveBeenLastCalledWith(expect.stringContaining("agent_preview_owner_intent_missing"));
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); container.remove();
    if (previous) Object.defineProperty(environment, "nativeAgentPreview", previous);
    else Reflect.deleteProperty(environment, "nativeAgentPreview");
    readEnvironment.mockRestore();
  }
});
