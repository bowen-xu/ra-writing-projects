/** @vitest-environment happy-dom */
import {act, useMemo} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {WorkspaceTabsProvider} from "@research-assistant/workbench-preview/workbench-c5927e";
import {getAppStorage, selectAppStorage} from "@research-assistant/workbench-preview/app-storage";
import {registerStoragePersistence} from "@research-assistant/workbench-preview/storage-persistence";
import {notify, type NotificationOptions} from "@research-assistant/workbench-preview/feedback";
import {AgentDraftProvider} from "@research-assistant/workbench-preview/agent-draft-provider";
import {projectConversationMessages} from "@research-assistant/workbench-preview/project-conversation-messages";
import {useAgentConversation} from "@research-assistant/workbench-preview/use-agent-conversation";
import {WritingDiffDemoStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-storage";
import {WritingDiffDemoAgentStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-agent-storage";
import {createWritingDiffDemoRuntime} from "@research-assistant/writing-projects-preview/writing-diff-demo-runtime";
import {acquireWritingSubmissionController, releaseWritingSubmissionController, resetWritingSubmissionControllersForTests} from "@research-assistant/workbench-preview/writing-submission-controller";
import {SpeechInputAdapterProvider} from "@research-assistant/workbench-preview/speech-input-adapter";
import {writingDemoSpeechAdapter} from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import {WritingAgentRuntimePanel} from "@research-assistant/writing-projects-preview/writing-agent-runtime-panel";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
function action(value: unknown) {
  if (!value || typeof value !== "object" || !("onClick" in value) || typeof value.onClick !== "function") return null;
  return {label: "label" in value ? value.label : undefined, click: () => (value.onClick as () => void)()};
}
function noticeAction(options: NotificationOptions | undefined, id: "primary" | "secondary") {
  return action(options?.actions?.find(value => value.id === id) ?? (id === "primary" ? options?.action : options?.cancel));
}
it.each([true, false])("restores cancellation without a native pointer and protects later operations (workspace ready=%s)", async workspaceReady => {
  const values = new Map<string, string>(); selectAppStorage({get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);}, removeItem: key => {values.delete(key);}, clear: () => values.clear()});
  const manuscriptId = crypto.randomUUID(), conversationId = crypto.randomUUID(), inputId = crypto.randomUUID();
  const files = new WritingDiffDemoStorage(manuscriptId, []), agent = new WritingDiffDemoAgentStorage(files, undefined);
  const runtime = createWritingDiffDemoRuntime(files, agent, manuscriptId, conversationId);
  const added = await runtime.queue.gateway.edit({manuscriptId, conversationId, requestId: crypto.randomUUID(), expectedRevision: 0,
    edit: {type: "add", inputId, text: "保留原队首", userInput: []}});
  const original = await runtime.queue.preview.prepare({inputId, expectedRevision: added.revision, submission: {conversationId,
    requestId: crypto.randomUUID(), text: "保留原队首", userInput: [], context: {manuscriptId, files: []}}});
  if (workspaceReady) await runtime.gateways.workspace.prepare({scope: {manuscriptId, conversationId, requestId: original.preview.requestId,
    contextSnapshotId: original.preview.contextSnapshotId}, buffers: []});
  runtime.queue.failNextCancel("afterCommit");
  const error = vi.spyOn(notify, "error").mockReturnValue(1), cancel = vi.spyOn(runtime.queue.preview, "cancel"),
    status = vi.spyOn(runtime.queue.preview, "cancelStatus"), start = vi.spyOn(runtime.queue.preview, "start");
  const dismiss = vi.spyOn(notify, "dismiss");
  const host = document.createElement("div"); document.body.append(host); let root = createRoot(host);
  function Harness() {
    const history = useAgentConversation(conversationId, undefined, runtime.history);
    const messages = useMemo(() => projectConversationMessages(history.projection), [history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} manuscriptId={manuscriptId} conversationId={conversationId}
      conversationTitle="取消恢复" activePath={undefined} content="" contentHash={undefined} files={[]} messages={messages}
      projection={history.projection} historyReady={history.status === "ready"} open onOpenChange={() => {}}/>;
  }
  async function render() {await act(async () => root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));}
  try {
    await render();
    await vi.waitFor(() => expect([...host.querySelectorAll("button")].find(button => button.textContent === "处理消息")?.disabled).toBe(false));
    expect(host.textContent).toContain("消息发送状态待确认");
    expect(host.textContent).not.toContain("完成后会自动继续");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "处理消息")!.click());
    const recoveryMessage = workspaceReady ? "有尚未发送的队列消息，请重新发送。" : "无法准备队列消息，原消息已保留，请检查后重试。";
    await vi.waitFor(() => expect(error.mock.calls.some(([message]) => typeof message === "string" && message.startsWith(recoveryMessage))).toBe(true));
    expect(error.mock.calls.find(([message]) => typeof message === "string" && message.startsWith(recoveryMessage))?.[1]?.dismissible).toBe(false);
    const edit = noticeAction(error.mock.calls.find(([message]) => typeof message === "string" && message.startsWith(recoveryMessage))?.[1], "secondary")!;
    if (!workspaceReady) for (const diagnostic of ["code=notFound", `C=${conversationId}`, `R=${original.preview.requestId}`, `contextSnapshot=${original.preview.contextSnapshotId}`])
      expect(error.mock.calls.find(([message]) => typeof message === "string" && message.startsWith(recoveryMessage))?.[0]).toContain(diagnostic);
    expect(edit).not.toBeNull(); await act(async () => edit.click());
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    const intent = cancel.mock.calls[0]![0]; expect(intent).toMatchObject({inputId, previewRequestId: original.preview.requestId});
    const committed = await runtime.queue.gateway.read({manuscriptId, conversationId}); expect(committed.preparingInputId).toBeNull();
    const newer = await runtime.queue.gateway.edit({manuscriptId, conversationId, requestId: crypto.randomUUID(), expectedRevision: committed.revision,
      edit: {type: "add", inputId: crypto.randomUUID(), text: "较新队尾", userInput: []}});
    await vi.waitFor(() => expect(noticeAction(error.mock.calls.at(-1)?.[1], "primary")?.label).toBe("核对原取消"));
    expect(error.mock.calls.at(-1)?.[1]?.dismissible).toBe(false);
    expect(error.mock.calls.at(-1)?.[1]?.id).toBe(1);
    expect(error.mock.calls.at(-1)?.[1]?.actions).toHaveLength(2);
    expect(error.mock.calls.at(-1)?.[1]?.cancel).toBeUndefined();
    const oldAction = noticeAction(error.mock.calls.at(-1)![1], "primary")!;
    await act(async () => root.unmount()); resetWritingSubmissionControllersForTests();
    oldAction.click();
    expect(status).not.toHaveBeenCalled(); root = createRoot(host); error.mockClear(); await render();
    await vi.waitFor(() => expect(noticeAction(error.mock.calls.at(-1)?.[1], "primary")?.label).toBe("核对原取消"));
    const message = error.mock.calls.at(-1)![0]; for (const id of [conversationId, inputId, original.preview.requestId, intent.requestId]) expect(message).toContain(id);
    expect(cancel).toHaveBeenCalledOnce(); expect(status).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    const check = noticeAction(error.mock.calls.at(-1)![1], "primary")!, retry = noticeAction(error.mock.calls.at(-1)![1], "secondary")!;
    const dismissedBefore = dismiss.mock.calls.length; await act(async () => check.click());
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="用第 1 条消息启动新轮次"]')?.disabled).toBe(false));
    expect(status).toHaveBeenCalledExactlyOnceWith(intent); expect(cancel).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    expect(dismiss.mock.calls.slice(dismissedBefore).some(([id]) => id === 1)).toBe(true);
    expect([...host.querySelectorAll(".agent-input-queue-body li p")].map(row => row.textContent)).toEqual(["保留原队首", "较新队尾"]);
    expect(await runtime.queue.gateway.read({manuscriptId, conversationId})).toEqual(newer);
    // Keep this same production controller mounted while a new cancellation O2
    // becomes unknown. Cached O1 toast actions must not act on the new intent.
    const ownerKey = JSON.stringify([runtime.identity, manuscriptId, conversationId]);
    const owner = acquireWritingSubmissionController(ownerKey, runtime.gateways.submission, runtime.gateways.turns, runtime.queue.preview);
    try {
      const resumed = await runtime.queue.gateway.edit({manuscriptId, conversationId, requestId: crypto.randomUUID(), expectedRevision: newer.revision,
        edit: {type: "resumeInput", inputId}});
      const second = await runtime.queue.preview.prepare({inputId, expectedRevision: resumed.revision, submission: {conversationId, requestId: crypto.randomUUID(),
        text: "保留原队首", userInput: [], context: {manuscriptId, files: []}}});
      await runtime.gateways.workspace.prepare({scope: {manuscriptId, conversationId, requestId: second.preview.requestId, contextSnapshotId: second.preview.contextSnapshotId}, buffers: []});
      error.mockClear(); await act(async () => owner.recoverQueued({manuscriptId, conversationId}));
      await vi.waitFor(() => expect(error.mock.calls.some(([message]) => message === "有尚未发送的队列消息，请重新发送。")).toBe(true));
      runtime.queue.failNextCancel("afterCommit");
      const cancelSecond = noticeAction(error.mock.calls.find(([message]) => message === "有尚未发送的队列消息，请重新发送。")?.[1], "secondary")!;
      await act(async () => cancelSecond.click());
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
      const secondIntent = cancel.mock.calls[1]![0]; expect(secondIntent.requestId).not.toBe(intent.requestId);
      await vi.waitFor(() => expect(owner.getSnapshot().cancellation?.phase).toBe("unknown"));
      const statusCalls = status.mock.calls.length, cancelCalls = cancel.mock.calls.length;
      await act(async () => {check.click(); retry.click(); edit.click(); cancelSecond.click();});
      expect(status).toHaveBeenCalledTimes(statusCalls); expect(cancel).toHaveBeenCalledTimes(cancelCalls);
      expect(owner.getSnapshot().cancellation?.intent).toEqual(secondIntent);
      await act(async () => owner.checkQueuedCancellation());
      const held = await runtime.queue.gateway.read({manuscriptId, conversationId}), ready = await runtime.queue.gateway.edit({manuscriptId, conversationId,
        requestId: crypto.randomUUID(), expectedRevision: held.revision, edit: {type: "resumeInput", inputId}});
      const third = await runtime.queue.preview.prepare({inputId, expectedRevision: ready.revision, submission: {conversationId, requestId: crypto.randomUUID(),
        text: "保留原队首", userInput: [], context: {manuscriptId, files: []}}});
      await runtime.gateways.workspace.prepare({scope: {manuscriptId, conversationId, requestId: third.preview.requestId, contextSnapshotId: third.preview.contextSnapshotId}, buffers: []});
      error.mockClear(); await act(async () => owner.recoverQueued({manuscriptId, conversationId}));
      await vi.waitFor(() => expect(error.mock.calls.some(([message]) => message === "有尚未发送的队列消息，请重新发送。")).toBe(true));
      await runtime.queue.gateway.edit({manuscriptId, conversationId, requestId: crypto.randomUUID(), expectedRevision: third.queue.revision,
        edit: {type: "add", inputId: crypto.randomUUID(), text: "使取消版本过期的队尾"}});
      const staleCancel = noticeAction(error.mock.calls.find(([message]) => message === "有尚未发送的队列消息，请重新发送。")?.[1], "secondary")!;
      await act(async () => staleCancel.click());
      await vi.waitFor(() => expect(noticeAction(error.mock.calls.at(-1)?.[1], "secondary")?.label).toBe("刷新预览后重新取消"));
      expect(owner.getSnapshot().cancellation?.definitiveConflict).toBe(true); expect(start).not.toHaveBeenCalled();
      registerStoragePersistence(getAppStorage(), {backend: "IndexedDB", pending: false, resetting: false, error: undefined,
        flush: async () => {if (![...values.keys()].some(key => key.startsWith("research-assistant:writing-queue-cancel:"))) throw new Error("cleanup failed");},
        retry: vi.fn(), reset: vi.fn(), subscribe: vi.fn(() => () => {}), close: vi.fn()});
      const refresh = noticeAction(error.mock.calls.at(-1)![1], "secondary")!; await act(async () => refresh.click());
      await vi.waitFor(() => expect(noticeAction(error.mock.calls.at(-1)?.[1], "secondary")?.label).toBe("重试本机清理"));
      expect(owner.getSnapshot().cancellation?.knownCommitted).toBe(true); expect(start).not.toHaveBeenCalled();
    } finally {releaseWritingSubmissionController(ownerKey, owner);}
  } finally {await act(async () => root.unmount()); host.remove(); resetWritingSubmissionControllersForTests(); runtime.dispose(); vi.restoreAllMocks();}
});
