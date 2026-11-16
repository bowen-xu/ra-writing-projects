/** @vitest-environment happy-dom */
import {act, useMemo} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {WorkspaceTabsProvider} from "@research-assistant/workbench-preview/workbench-c5927e";
import {selectAppStorage} from "@research-assistant/workbench-preview/app-storage";
import {notify, type NotificationOptions} from "@research-assistant/workbench-preview/feedback";
import {AgentDraftProvider} from "@research-assistant/workbench-preview/agent-draft-provider";
import {projectConversationMessages} from "@research-assistant/workbench-preview/project-conversation-messages";
import {useAgentConversation} from "@research-assistant/workbench-preview/use-agent-conversation";
import {WritingDiffDemoStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-storage";
import {WritingDiffDemoAgentStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-agent-storage";
import {createWritingDiffDemoRuntime} from "@research-assistant/writing-projects-preview/writing-diff-demo-runtime";
import {WritingSubmissionController, resetWritingSubmissionControllersForTests} from "@research-assistant/workbench-preview/writing-submission-controller";
import {SpeechInputAdapterProvider} from "@research-assistant/workbench-preview/speech-input-adapter";
import {writingDemoSpeechAdapter} from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import {WritingAgentRuntimePanel} from "@research-assistant/writing-projects-preview/writing-agent-runtime-panel";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const run of cleanup.splice(0).reverse()) await run(); resetWritingSubmissionControllersForTests(); vi.restoreAllMocks();});
function action(options: NotificationOptions | undefined, id: "primary" | "secondary") {
  const value = options?.actions?.find(value => value.id === id) ?? (id === "primary" ? options?.action : options?.cancel);
  if (!value || typeof value !== "object" || !("onClick" in value) || typeof value.onClick !== "function") throw new Error(`Missing ${id} action`);
  return {label: "label" in value ? value.label : undefined, click: () => (value.onClick as () => void | Promise<void>)()};
}
async function fixture(fault: "beforeAdmission" | "afterAdmission" | "afterStarted") {
  const rows = new Map<string, string>(), storage: Storage = {get length() {return rows.size;}, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => {rows.set(key, value);}, removeItem: key => {rows.delete(key);}, clear: () => rows.clear()}; selectAppStorage(storage);
  const scope = {manuscriptId: crypto.randomUUID(), conversationId: crypto.randomUUID()}, inputId = crypto.randomUUID(), tailId = crypto.randomUUID();
  const files = new WritingDiffDemoStorage(scope.manuscriptId, []), agent = new WritingDiffDemoAgentStorage(files, undefined),
    runtime = createWritingDiffDemoRuntime(files, agent, scope.manuscriptId, scope.conversationId); runtime.execution.historyOnly = true;
  cleanup.push(() => runtime.dispose());
  let queue = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: 0, edit: {type: "add", inputId, text: "原启动输入"}});
  queue = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: queue.revision, edit: {type: "add", inputId: tailId, text: "保留暂停队尾"}});
  queue = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: queue.revision, edit: {type: "pauseInput", inputId: tailId}});
  const request = {conversationId: scope.conversationId, requestId: crypto.randomUUID(), text: "原启动输入", context: {manuscriptId: scope.manuscriptId, files: []}};
  const owner = new WritingSubmissionController(runtime.gateways.submission, runtime.gateways.turns, runtime.queue.preview, {scope, storage});
  await owner.prepareQueued(request, inputId, queue.revision);
  const preview = owner.getSnapshot().preview!;
  await runtime.gateways.workspace.prepare({scope: {...scope, requestId: request.requestId, contextSnapshotId: preview.contextSnapshotId}, buffers: []});
  await owner.observeWorkspacePreparation(request.requestId, true);
  runtime.queue.failNextStart(fault); await owner.confirm("deepSeekNonThinking"); owner.dispose();
  const locator = [...rows.entries()].find(([key]) => key.startsWith("research-assistant:writing-queue-start:"))!;
  const frozen = JSON.parse(locator[1]) as {intent: Parameters<typeof runtime.queue.preview.start>[0]};
  const queueSnapshot = runtime.queue.snapshot(), executionSnapshot = runtime.execution.snapshot(), historySnapshot = agent.history.snapshot();
  const reopenedAgent = new WritingDiffDemoAgentStorage(files, undefined), reopened = createWritingDiffDemoRuntime(files, reopenedAgent, scope.manuscriptId, scope.conversationId);
  reopened.execution.historyOnly = true; reopenedAgent.history.restore(historySnapshot); reopened.execution.restore(executionSnapshot); reopened.queue.restore(queueSnapshot);
  cleanup.push(() => reopened.dispose());
  return {scope, inputId, tailId, rows, locator, frozen: frozen.intent, runtime: reopened};
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const error = vi.spyOn(notify, "error").mockReturnValue(31), onAdmitted = vi.fn(), host = document.createElement("div"); document.body.append(host);
  const root: Root = createRoot(host); cleanup.push(async () => {await act(async () => root.unmount()); host.remove();});
  function Harness() {
    const history = useAgentConversation(f.scope.conversationId, undefined, f.runtime.history), messages = useMemo(() => projectConversationMessages(history.projection), [history.projection]);
    return <WritingAgentRuntimePanel gateways={f.runtime.gateways} {...f.scope} conversationTitle="启动恢复" activePath={undefined} content="" contentHash={undefined}
      files={[]} messages={messages} projection={history.projection} historyReady={history.status === "ready"} onSubmissionAdmitted={onAdmitted} open onOpenChange={() => {}}/>;
  }
  await act(async () => root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
  await vi.waitFor(() => expect(action(error.mock.calls.at(-1)?.[1], "primary").label).toBe("核对原启动"));
  expect(error.mock.calls.at(-1)?.[1]?.dismissible).toBe(false);
  return {error, onAdmitted, host};
}
it("reopens an Unknown start without automatic I/O, reads the original prepared claim, and explicitly retries its original Q/mode", async () => {
  const f = await fixture("beforeAdmission"), start = vi.spyOn(f.runtime.queue.preview, "start"), status = vi.spyOn(f.runtime.queue.preview, "startStatus"),
    workspace = vi.spyOn(f.runtime.gateways.workspace, "restore"), prepareWorkspace = vi.spyOn(f.runtime.gateways.workspace, "prepare"), prepare = vi.spyOn(f.runtime.queue.preview, "prepare");
  // A normal reopen Pause advances Q; the Unknown start must keep its first Q.
  const current = await f.runtime.queue.gateway.read(f.scope), view = await mount(f), oldRetry = action(view.error.mock.calls.at(-1)?.[1], "secondary");
  expect(f.rows.get(f.locator[0])).toBe(f.locator[1]); expect(status).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  const input = view.host.querySelector("textarea")!;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "新的草稿不能替换原启动"); input.dispatchEvent(new Event("input", {bubbles: true}));});
  await act(async () => view.host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  expect(input.value).toBe("新的草稿不能替换原启动"); expect(status).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(workspace).not.toHaveBeenCalled(); expect(prepareWorkspace).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  await act(async () => action(view.error.mock.calls.at(-1)?.[1], "primary").click());
  expect(status).toHaveBeenCalledExactlyOnceWith(f.frozen); expect(start).not.toHaveBeenCalled(); expect(workspace).not.toHaveBeenCalled(); expect(prepareWorkspace).not.toHaveBeenCalled();
  await act(async () => oldRetry.click()); expect(start).not.toHaveBeenCalled(); // original unknown-phase callback is fenced
  await act(async () => action(view.error.mock.calls.at(-1)?.[1], "secondary").click());
  expect(start).toHaveBeenCalledExactlyOnceWith(f.frozen); expect(f.frozen.expectedRevision).toBeLessThan(current.revision);
  expect(f.rows.get(f.locator[0])).toBe(f.locator[1]); expect(view.onAdmitted).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(await f.runtime.queue.gateway.read(f.scope)).toEqual(current); expect(workspace).not.toHaveBeenCalled(); expect(prepareWorkspace).not.toHaveBeenCalled();
});
it("real Started history does not auto-clear a lost-ACK intent; explicit check observes it without workspace or another model", async () => {
  const f = await fixture("afterStarted"), status = vi.spyOn(f.runtime.queue.preview, "startStatus"), start = vi.spyOn(f.runtime.queue.preview, "start"),
    workspace = vi.spyOn(f.runtime.gateways.workspace, "restore"), prepareWorkspace = vi.spyOn(f.runtime.gateways.workspace, "prepare"), execute = vi.spyOn(f.runtime.execution, "validateQueuedStart");
  // Missing execution-copy metadata and an unavailable route cannot hide real facts.
  f.runtime.execution.restore(f.runtime.execution.snapshot().map(([key, value]) => {const {workspace: _workspace, buffers: _buffers, ...record} = value; return [key, record] as const;}));
  f.runtime.queue.failNextStart("unavailable"); const current = await f.runtime.queue.gateway.read(f.scope), view = await mount(f);
  expect(status).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(f.rows.get(f.locator[0])).toBe(f.locator[1]); expect(view.onAdmitted).not.toHaveBeenCalled();
  const check = action(view.error.mock.calls.at(-1)?.[1], "primary"), retry = action(view.error.mock.calls.at(-1)?.[1], "secondary");
  await act(async () => check.click());
  expect(status).toHaveBeenCalledExactlyOnceWith(f.frozen); expect(f.rows.has(f.locator[0])).toBe(false); expect(view.onAdmitted).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(workspace).not.toHaveBeenCalled(); expect(prepareWorkspace).not.toHaveBeenCalled();
  expect(await f.runtime.queue.gateway.read(f.scope)).toEqual(current);
  await act(async () => {await check.click(); await retry.click();}); expect(status).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled(); expect(view.onAdmitted).toHaveBeenCalledOnce();
});
it("an admitted request requires a separate explicit Resume, then starts the original request while keeping the paused tail", async () => {
  const f = await fixture("afterAdmission"), start = vi.spyOn(f.runtime.queue.preview, "start"), edit = vi.spyOn(f.runtime.queue.gateway, "edit"), view = await mount(f);
  const check = action(view.error.mock.calls.at(-1)?.[1], "primary"); await act(async () => check.click());
  expect(start).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  await act(async () => action(view.error.mock.calls.at(-1)?.[1], "secondary").click());
  expect(action(view.error.mock.calls.at(-1)?.[1], "secondary").label).toBe("恢复队列并继续原启动"); expect(start).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  const before = await f.runtime.queue.gateway.read(f.scope);
  await act(async () => action(view.error.mock.calls.at(-1)?.[1], "secondary").click());
  expect(edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({...f.scope, expectedRevision: before.revision, edit: {type: "resume"}}));
  expect(start).toHaveBeenCalledExactlyOnceWith(f.frozen); expect(view.onAdmitted).toHaveBeenCalledOnce(); expect(f.rows.has(f.locator[0])).toBe(false);
  const after = await f.runtime.queue.gateway.read(f.scope); expect(after.paused).toBe(false); expect(after.inputs).toMatchObject([{inputId: f.tailId, paused: true}]);
});
