/** @vitest-environment happy-dom */
import {act, useMemo} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {decodeAgentWritingPrepareRequest, type AgentWorkspaceBuffer} from "@research-assistant/core/agent";
import {WorkspaceTabsProvider} from "../../../../../apps/web/src/core/public/workbench";
import {selectAppStorage} from "../../../../../apps/web/src/core/runtime/appStorage";
import {registerStoragePersistence} from "../../../../../apps/web/src/core/runtime/storagePersistence";
import {notify, type NotificationOptions} from "../../../../../apps/web/src/core/public/feedback";
import {AgentDraftProvider} from "../../../../../apps/web/src/core/features/agent/AgentDraftProvider";
import {projectConversationMessages} from "../../../../../apps/web/src/core/features/agent/projectConversationMessages";
import {useAgentConversation} from "../../../../../apps/web/src/core/features/agent/useAgentConversation";
import {WritingDiffDemoStorage} from "../../../../../apps/web/src/app/previews/agent/WritingDiffDemoStorage";
import {WritingDiffDemoAgentStorage} from "../../../../../apps/web/src/app/previews/agent/WritingDiffDemoAgentStorage";
import {createWritingDiffDemoRuntime} from "../../../../../apps/web/src/app/previews/agent/writingDiffDemoRuntime";
import {WritingSubmissionController, acquireWritingSubmissionController, releaseWritingSubmissionController,
  resetWritingSubmissionControllersForTests} from "../../../../../apps/web/src/core/features/agent/writingSubmissionController";
import {SpeechInputAdapterProvider} from "../../../../../apps/web/src/core/features/speech/SpeechInputAdapter";
import {writingDemoSpeechAdapter} from "../../../../../apps/web/src/app/previews/agent/WritingDemoSpeechAdapter";
import {WritingAgentRuntimePanel} from "./WritingAgentRuntimePanel";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetWritingSubmissionControllersForTests(); vi.restoreAllMocks();
});
function action(options: NotificationOptions | undefined, id: "primary" | "secondary") {
  const value = options?.actions?.find(item => item.id === id) ?? (id === "primary" ? options?.action : options?.cancel);
  if (!value || typeof value !== "object" || !("onClick" in value) || typeof value.onClick !== "function") throw new Error(`Missing ${id} action`);
  return {label: "label" in value ? value.label : undefined, click: () => (value.onClick as () => void | Promise<void>)()};
}
async function fixture(fault: "beforeCommit" | "afterCommit" = "afterCommit") {
  const rows = new Map<string, string>(), storage: Storage = {get length() {return rows.size;}, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => {rows.set(key, value);}, removeItem: key => {rows.delete(key);}, clear: () => rows.clear()};
  selectAppStorage(storage);
  const scope = {manuscriptId: crypto.randomUUID(), conversationId: crypto.randomUUID()}, traceId = crypto.randomUUID();
  const files = new WritingDiffDemoStorage(scope.manuscriptId, [{path: "main.tex", before: "original disk source", after: "original disk source", kind: "modified", additions: 0, deletions: 0}]);
  const disk = await files.files.readFile(scope.manuscriptId, "main.tex");
  const buffers: readonly AgentWorkspaceBuffer[] = [{path: "main.tex", expectedDiskSha256: disk.sha256,
    sessionId: crypto.randomUUID(), revision: crypto.randomUUID(), text: "original unsaved source"}];
  const request = decodeAgentWritingPrepareRequest({conversationId: scope.conversationId, requestId: crypto.randomUUID(), text: "保留原输入",
    model: {providerId: "deepseek", modelId: "deepseek-v4-pro"}, retrieval: {traceId, query: "original retrieval query"},
    context: {manuscriptId: scope.manuscriptId, files: [{relativePath: "main.tex", expectedDiskSha256: disk.sha256,
      buffer: {revision: buffers[0]!.revision, text: buffers[0]!.text}}]}});
  const agent = new WritingDiffDemoAgentStorage(files, undefined), original = createWritingDiffDemoRuntime(files, agent, scope.manuscriptId, scope.conversationId);
  const consume = vi.fn();
  original.execution.retrievalPreparation = async () => ({context: [{sourceId: `retrieval:${traceId}`, revision: `trace:${traceId}`, kind: "retrieval",
    resourceId: "global-research", anchor: JSON.stringify({manuscriptId: scope.manuscriptId, traceId, query: request.retrieval!.query}), text: "original retrieval source"}],
    commit: accept => {accept(); consume();}});
  const owner = new WritingSubmissionController(original.gateways.submission, original.gateways.turns, original.queue.preview, {scope, storage});
  original.execution.failNextPrepare(fault); await owner.prepare(request, undefined, buffers); owner.dispose();
  expect(owner.getSnapshot().writingPreparation?.phase).toBe("unknown");
  const records = original.execution.snapshot(), events = agent.history.snapshot(); original.dispose();
  const reopenedAgent = new WritingDiffDemoAgentStorage(files, undefined), runtime = createWritingDiffDemoRuntime(files, reopenedAgent, scope.manuscriptId, scope.conversationId);
  runtime.execution.historyOnly = true; runtime.execution.restore(records); reopenedAgent.history.restore(events);
  cleanups.push(() => runtime.dispose());
  const locator = [...rows.entries()].find(([key]) => key.startsWith("research-assistant:writing-prepare:"))!;
  return {rows, storage, scope, request, buffers, disk, files, runtime, locator, consume};
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const error = vi.spyOn(notify, "error").mockReturnValue(41), admitted = vi.fn(), host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); let detached = false;
  const unmount = async () => {if (!detached) {detached = true; await act(async () => root.unmount()); host.remove();}};
  cleanups.push(unmount);
  const editor = {documentKey: `${f.scope.manuscriptId}:main.tex`, sessionId: crypto.randomUUID(), revision: crypto.randomUUID(), text: "later editor source"};
  const files = await f.files.files.listFiles(f.scope.manuscriptId);
  function Harness() {
    const history = useAgentConversation(f.scope.conversationId, undefined, f.runtime.history), messages = useMemo(() => projectConversationMessages(history.projection), [history.projection]);
    return <WritingAgentRuntimePanel gateways={f.runtime.gateways} {...f.scope} conversationTitle="准备恢复"
      activePath="main.tex" content={editor.text} contentHash={f.disk.sha256} readEditorSnapshot={() => editor}
      files={files} messages={messages} projection={history.projection} historyReady={history.status === "ready"}
      onSubmissionAdmitted={admitted} open onOpenChange={() => {}}/>;
  }
  await act(async () => root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
  await vi.waitFor(() => expect(action(error.mock.calls.at(-1)?.[1], "primary").label).toBe("核对原准备"));
  expect(error.mock.calls.at(-1)?.[1]?.dismissible).toBe(false);
  return {error, admitted, host, unmount};
}
function ports(f: Awaited<ReturnType<typeof fixture>>) {
  return {prepare: vi.spyOn(f.runtime.gateways.submission, "prepareWriting"), status: vi.spyOn(f.runtime.gateways.submission, "prepareWritingStatus"),
    restore: vi.spyOn(f.runtime.gateways.workspace, "restore"), workspace: vi.spyOn(f.runtime.gateways.workspace, "prepare"),
    start: vi.spyOn(f.runtime.gateways.submission, "startWriting")};
}
it("reopens a lost preparation ACK and checks only the immutable original fact after current dependencies change", async () => {
  const f = await fixture(), p = ports(f), view = await mount(f), old = view.error.mock.calls.at(-1)!;
  f.runtime.setModelMode("openai");
  const read = vi.spyOn(f.files.files, "readFile").mockRejectedValue(new Error("current source removed"));
  const freeze = vi.spyOn(f.runtime.resources, "freeze").mockRejectedValue(new Error("current model resources unavailable"));
  const retrieval = vi.fn(async (): Promise<never> => {throw new Error("original retrieval trace already consumed");}); f.runtime.execution.retrievalPreparation = retrieval;
  expect(f.consume).toHaveBeenCalledOnce(); expect(p.prepare).not.toHaveBeenCalled(); expect(p.status).not.toHaveBeenCalled();
  expect(p.restore).not.toHaveBeenCalled(); expect(p.workspace).not.toHaveBeenCalled(); expect(p.start).not.toHaveBeenCalled();
  for (const id of [f.scope.conversationId, f.request.requestId]) expect(old[0]).toContain(id);
  const check = action(old[1], "primary"), retry = action(old[1], "secondary"); await act(async () => check.click());
  await vi.waitFor(() => expect(view.error.mock.calls.some(([message]) => message === "原准备已恢复，请明确继续原请求。")).toBe(true));
  expect(p.status).toHaveBeenCalledExactlyOnceWith(f.request); expect(p.prepare).not.toHaveBeenCalled(); expect(p.start).not.toHaveBeenCalled();
  expect(p.restore).not.toHaveBeenCalled(); expect(p.workspace).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled(); expect(retrieval).not.toHaveBeenCalled();
  expect(f.rows.has(f.locator[0])).toBe(true); await act(async () => {await check.click(); await retry.click();});
  expect(p.status).toHaveBeenCalledOnce(); expect(p.prepare).not.toHaveBeenCalled(); expect(view.admitted).not.toHaveBeenCalled();
});
it("requires explicit continuation and creates the execution copy with the original saved buffers", async () => {
  const f = await fixture(), p = ports(f), view = await mount(f); await act(async () => action(view.error.mock.calls.at(-1)?.[1], "primary").click());
  const notice = view.error.mock.calls.find(([message]) => message === "原准备已恢复，请明确继续原请求。")!;
  expect(p.restore).not.toHaveBeenCalled(); expect(p.workspace).not.toHaveBeenCalled(); expect(p.start).not.toHaveBeenCalled();
  const send = action(notice[1], "primary"); expect(send.label).toBe("重新发送"); await act(async () => send.click());
  await vi.waitFor(() => expect(p.start).toHaveBeenCalledOnce());
  expect(p.restore).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({...f.scope, requestId: f.request.requestId}));
  expect(p.workspace).toHaveBeenCalledExactlyOnceWith({scope: expect.objectContaining({...f.scope, requestId: f.request.requestId}), buffers: f.buffers});
  expect(p.start.mock.calls[0]![0]).toMatchObject({...f.scope, requestId: f.request.requestId,
    model: {providerId: f.request.model!.providerId, modelId: f.request.model!.modelId}});
  expect(p.prepare).not.toHaveBeenCalled(); expect(p.status).toHaveBeenCalledOnce(); expect(view.admitted).toHaveBeenCalledOnce(); expect(f.rows.has(f.locator[0])).toBe(false);
  await act(async () => send.click()); expect(p.start).toHaveBeenCalledOnce(); expect(p.workspace).toHaveBeenCalledOnce();
});
it("NotFound retries the complete original request under the same R without using the current composer", async () => {
  const f = await fixture("beforeCommit"), p = ports(f), view = await mount(f);
  const input = view.host.querySelector("textarea")!;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "later draft must remain"); input.dispatchEvent(new Event("input", {bubbles: true}));});
  await act(async () => action(view.error.mock.calls.at(-1)?.[1], "primary").click());
  expect(p.status).toHaveBeenCalledExactlyOnceWith(f.request); expect(p.prepare).not.toHaveBeenCalled();
  f.runtime.execution.retrievalPreparation = async () => ({context: [{sourceId: `retrieval:${f.request.retrieval!.traceId}`, revision: `trace:${f.request.retrieval!.traceId}`, kind: "retrieval", resourceId: "global-research",
    anchor: JSON.stringify({manuscriptId: f.scope.manuscriptId, traceId: f.request.retrieval!.traceId, query: f.request.retrieval!.query}), text: "original retrieval source"}], commit: accept => accept()});
  await act(async () => action(view.error.mock.calls.at(-1)?.[1], "secondary").click());
  expect(p.prepare).toHaveBeenCalledExactlyOnceWith(f.request); expect(input.value).toBe("later draft must remain");
  expect(p.workspace).not.toHaveBeenCalled(); expect(p.start).not.toHaveBeenCalled(); expect(f.rows.has(f.locator[0])).toBe(true);
});
it("known committed local persistence recovery stays local after reopening and detached notifications cannot send", async () => {
  const f = await fixture(), p = ports(f); let fail = true;
  registerStoragePersistence(f.storage, {backend: "IndexedDB", pending: false, error: undefined, resetting: false,
    flush: async () => {if (fail) throw new Error("synthetic local committed save failure");}, retry: async () => {}, reset: async () => {}, subscribe: () => () => {}, close: () => {}});
  const first = await mount(f); await act(async () => action(first.error.mock.calls.at(-1)?.[1], "primary").click());
  expect(action(first.error.mock.calls.at(-1)?.[1], "secondary").label).toBe("重试本机收尾"); expect(p.status).toHaveBeenCalledOnce();
  await first.unmount(); resetWritingSubmissionControllersForTests(); fail = false;
  const view = await mount(f), check = action(view.error.mock.calls.at(-1)?.[1], "primary"), retry = action(view.error.mock.calls.at(-1)?.[1], "secondary");
  expect(retry.label).toBe("重试本机收尾"); await act(async () => retry.click());
  expect(p.status).toHaveBeenCalledOnce(); expect(p.prepare).not.toHaveBeenCalled();
  const ready = view.error.mock.calls.find(([message]) => message === "原准备已恢复，请明确继续原请求。")!;
  const send = action(ready[1], "primary"); await view.unmount(); await act(async () => {await check.click(); await retry.click(); await send.click();});
  expect(p.status).toHaveBeenCalledOnce(); expect(p.prepare).not.toHaveBeenCalled(); expect(p.restore).not.toHaveBeenCalled(); expect(p.workspace).not.toHaveBeenCalled(); expect(p.start).not.toHaveBeenCalled();
});
it("old original-request notifications cannot check, retry or continue a newer R on the same mounted owner", async () => {
  const f = await fixture(), p = ports(f), view = await mount(f), old = view.error.mock.calls.at(-1)!;
  const check = action(old[1], "primary"), retry = action(old[1], "secondary"); await act(async () => check.click());
  const ready = view.error.mock.calls.find(([message]) => message === "原准备已恢复，请明确继续原请求。")!;
  const send = action(ready[1], "primary"), ownerKey = JSON.stringify([f.runtime.identity, f.scope.manuscriptId, f.scope.conversationId]);
  const owner = acquireWritingSubmissionController(ownerKey, f.runtime.gateways.submission, f.runtime.gateways.turns, f.runtime.queue.preview);
  try {
    await act(async () => {expect(await owner.abandonWritingPreparation()).toBe(f.request.text);});
    const second = {...f.request, requestId: crypto.randomUUID(), text: "newer original request"}; f.runtime.execution.failNextPrepare("beforeCommit");
    await act(async () => owner.prepare(second, undefined, f.buffers));
    expect(owner.getSnapshot().writingPreparation).toMatchObject({phase: "unknown", intent: second});
    const locator = f.rows.get(f.locator[0]), calls = {status: p.status.mock.calls.length, prepare: p.prepare.mock.calls.length};
    await act(async () => {await check.click(); await retry.click(); await send.click();});
    expect(p.status).toHaveBeenCalledTimes(calls.status); expect(p.prepare).toHaveBeenCalledTimes(calls.prepare);
    expect(p.restore).not.toHaveBeenCalled(); expect(p.workspace).not.toHaveBeenCalled(); expect(p.start).not.toHaveBeenCalled();
    expect(f.rows.get(f.locator[0])).toBe(locator); expect(owner.getSnapshot().writingPreparation?.intent).toEqual(second);
  } finally {releaseWritingSubmissionController(ownerKey, owner);}
});
