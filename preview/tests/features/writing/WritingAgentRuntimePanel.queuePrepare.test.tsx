/** @vitest-environment happy-dom */
import {act, useMemo} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
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
import {parseManuscriptPath} from "@research-assistant/writing";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
function noticeAction(options: NotificationOptions | undefined, id: "primary" | "secondary") {
  const action = options?.actions?.find(value => value.id === id) ?? (id === "primary" ? options?.action : options?.cancel);
  return action && typeof action === "object" && "onClick" in action && typeof action.onClick === "function"
    ? {label: "label" in action ? action.label : undefined, click: () => (action.onClick as () => void | Promise<void>)()} : null;
}
it("reopens the production owner without automatic prepare and explicitly sends the original current claim after readonly proof", async () => {
  const values = new Map<string, string>(), storage: Storage = {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);}, removeItem: key => {values.delete(key);}, clear: () => values.clear()};
  selectAppStorage(storage);
  const locatorCount = () => [...values.keys()].filter(key => key.startsWith("research-assistant:writing-queue-prepare:")).length;
  const manuscriptId = crypto.randomUUID(), conversationId = crypto.randomUUID(), inputId = crypto.randomUUID(), scope = {manuscriptId, conversationId};
  const files = new WritingDiffDemoStorage(manuscriptId, [{path: "main.tex", before: "disk baseline", after: "disk baseline", kind: "modified", additions: 0, deletions: 0}]),
    agent = new WritingDiffDemoAgentStorage(files, undefined), runtime = createWritingDiffDemoRuntime(files, agent, manuscriptId, conversationId);
  const disk = await files.files.readFile(manuscriptId, "main.tex"), buffers = [{path: "main.tex", expectedDiskSha256: disk.sha256,
    sessionId: crypto.randomUUID(), revision: crypto.randomUUID(), text: "original unsaved source"}];
  const added = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: 0, edit: {type: "add", inputId, text: "保留原输入", userInput: []}});
  const request = {conversationId, requestId: crypto.randomUUID(), text: "保留原输入", context: {manuscriptId, files: [{relativePath: "main.tex", expectedDiskSha256: disk.sha256,
    buffer: {revision: buffers[0]!.revision, text: buffers[0]!.text}}]}, resources: [{kind: "manuscript" as const,
    resourceId: manuscriptId, parts: [], groupAccess: "readOnly" as const, newMemberAccess: "readOnly" as const}]};
  const prepare = vi.spyOn(runtime.queue.preview, "prepare"), status = vi.spyOn(runtime.queue.preview, "prepareStatus"), start = vi.spyOn(runtime.queue.preview, "start");
  const originalOwner = new WritingSubmissionController(runtime.gateways.submission, runtime.gateways.turns, runtime.queue.preview, {scope, storage});
  runtime.queue.failNextPrepare("afterCommit"); await originalOwner.prepareQueued(request, inputId, added.revision, undefined, buffers); originalOwner.dispose();
  const prepareWorkspace = vi.spyOn(runtime.gateways.workspace, "prepare");
  const claim = await runtime.queue.gateway.read(scope), tailId = crypto.randomUUID(), appended = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: claim.revision,
    edit: {type: "add", inputId: tailId, text: "保留较新队尾"}});
  await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: appended.revision, edit: {type: "pauseInput", inputId: tailId}});
  runtime.queue.restore(runtime.queue.snapshot()); const latest = await runtime.queue.gateway.read(scope);
  const error = vi.spyOn(notify, "error").mockReturnValue(1), host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const history = useAgentConversation(conversationId, undefined, runtime.history), messages = useMemo(() => projectConversationMessages(history.projection), [history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} manuscriptId={manuscriptId} conversationId={conversationId} conversationTitle="准备恢复"
      activePath={undefined} content="" contentHash={undefined} files={[]} messages={messages} projection={history.projection}
      historyReady={history.status === "ready"} open onOpenChange={() => {}}/>;
  }
  try {
    await act(async () => root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
    await vi.waitFor(() => expect(noticeAction(error.mock.calls.at(-1)?.[1], "primary")?.label).toBe("核对原准备"));
    expect(error.mock.calls.at(-1)?.[1]?.dismissible).toBe(false); expect(prepare).toHaveBeenCalledOnce(); expect(status).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    const check = noticeAction(error.mock.calls.at(-1)?.[1], "primary")!, retry = noticeAction(error.mock.calls.at(-1)?.[1], "secondary")!;
    for (const id of [conversationId, inputId, request.requestId]) expect(error.mock.calls.at(-1)![0]).toContain(id);
    await act(async () => check.click());
    await vi.waitFor(() => expect(error.mock.calls.some(([message]) => message === "有尚未发送的队列消息，请重新发送。")).toBe(true));
    expect(status).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    expect(prepareWorkspace).not.toHaveBeenCalled(); expect(locatorCount()).toBe(1);
    const send = noticeAction(error.mock.calls.find(([message]) => message === "有尚未发送的队列消息，请重新发送。")?.[1], "primary")!;
    await act(async () => send.click()); await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]![0]).toMatchObject({inputId, expectedRevision: latest.revision, start: {requestId: request.requestId}});
    expect(prepareWorkspace).toHaveBeenCalledExactlyOnceWith({scope: expect.objectContaining({requestId: request.requestId}), buffers}); expect(locatorCount()).toBe(0);
    const current = await runtime.queue.gateway.read(scope); expect(current.paused).toBe(false); expect(current.revision).toBe(latest.revision + 2);
    expect(current.inputs.map(input => input.text)).toEqual(["保留较新队尾"]); expect(current.inputs[0]?.paused).toBe(true);
    await act(async () => {await check.click(); await retry.click();});
    expect(prepare).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
  } finally {await act(async () => root.unmount()); host.remove(); resetWritingSubmissionControllersForTests(); runtime.dispose(); vi.restoreAllMocks();}
});
it("returning a rejected manual queue preparation cannot trigger an automatic fresh request", async () => {
  const values = new Map<string, string>(), storage: Storage = {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);}, removeItem: key => {values.delete(key);}, clear: () => values.clear()}; selectAppStorage(storage);
  const manuscriptId = crypto.randomUUID(), conversationId = crypto.randomUUID(), inputId = crypto.randomUUID(), scope = {manuscriptId, conversationId};
  const files = new WritingDiffDemoStorage(manuscriptId, [{path: "main.tex", before: "original", after: "original", kind: "modified", additions: 0, deletions: 0}]),
    agent = new WritingDiffDemoAgentStorage(files, undefined), runtime = createWritingDiffDemoRuntime(files, agent, manuscriptId, conversationId);
  const disk = await files.files.readFile(manuscriptId, "main.tex"), editor = {documentKey: `${manuscriptId}:main.tex`, sessionId: crypto.randomUUID(), revision: crypto.randomUUID(), text: disk.content};
  const added = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: 0, edit: {type: "add", inputId, text: "manual input"}});
  const appended = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: added.revision, edit: {type: "add", inputId: crypto.randomUUID(), text: "tail"}});
  await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: appended.revision, edit: {type: "pause"}});
  runtime.queue.failNextPrepare("rejected"); const prepare = vi.spyOn(runtime.queue.preview, "prepare"), start = vi.spyOn(runtime.queue.preview, "start"), error = vi.spyOn(notify, "error").mockReturnValue(2);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const history = useAgentConversation(conversationId, undefined, runtime.history), messages = useMemo(() => projectConversationMessages(history.projection), [history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} manuscriptId={manuscriptId} conversationId={conversationId} conversationTitle="拒绝恢复"
      activePath="main.tex" content={disk.content} contentHash={disk.sha256} readEditorSnapshot={() => editor}
      files={[{manuscriptId, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: disk.sha256, sizeBytes: 8, modifiedAt: "now"}]}
      messages={messages} projection={history.projection} historyReady={history.status === "ready"} open onOpenChange={() => {}}/>;
  }
  try {
    await act(async () => root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="用第 1 条消息启动新轮次"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="用第 1 条消息启动新轮次"]')!.click());
    await vi.waitFor(() => expect(noticeAction(error.mock.calls.at(-1)?.[1], "secondary")?.label).toBe("返回队列"));
    expect(prepare).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    const edit = vi.spyOn(runtime.queue.gateway, "edit"), originalQueue = await runtime.queue.gateway.read(scope), back = noticeAction(error.mock.calls.at(-1)?.[1], "secondary")!;
    await act(async () => back.click());
    expect(prepare).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    const held = await runtime.queue.gateway.read(scope); expect(held.revision).toBe(originalQueue.revision + 1);
    expect(held.inputs.map(input => input.text)).toEqual(["manual input", "tail"]); expect(held.inputs[0]?.paused).toBe(true);
    expect(held.inputs[1]).toEqual(originalQueue.inputs[1]); expect(edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({edit: {type: "pauseInput", inputId}}));
    await act(async () => back.click()); expect(edit).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  } finally {await act(async () => root.unmount()); host.remove(); resetWritingSubmissionControllersForTests(); runtime.dispose(); vi.restoreAllMocks();}
});
