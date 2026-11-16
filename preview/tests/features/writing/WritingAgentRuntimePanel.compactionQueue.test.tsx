/** @vitest-environment happy-dom */
import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AgentWritingQueueResponse, AgentWritingQueuedCompactionSettleRequest } from "@research-assistant/core/agent";
import { WorkspaceTabsProvider } from "@research-assistant/workbench-preview/workbench-c5927e";
import { selectAppStorage } from "@research-assistant/workbench-preview/app-storage";
import { AgentDraftProvider } from "@research-assistant/workbench-preview/agent-draft-provider";
import { projectConversationMessages } from "@research-assistant/workbench-preview/project-conversation-messages";
import { useAgentConversation } from "@research-assistant/workbench-preview/use-agent-conversation";
import { WritingDiffDemoStorage } from "@research-assistant/writing-projects-preview/writing-diff-demo-storage";
import { WritingDiffDemoAgentStorage } from "@research-assistant/writing-projects-preview/writing-diff-demo-agent-storage";
import { createWritingDiffDemoRuntime } from "@research-assistant/writing-projects-preview/writing-diff-demo-runtime";
import { SpeechInputAdapterProvider } from "@research-assistant/workbench-preview/speech-input-adapter";
import { writingDemoSpeechAdapter } from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import { resetWritingCompactionOwnersForTests } from "@research-assistant/writing-projects-preview/writing-compaction-controller";
import { WritingAgentRuntimePanel } from "@research-assistant/writing-projects-preview/writing-agent-runtime-panel";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise, resolve};
}

it("reloads the current queue after a delayed settlement of an externally prepared compact recovered through the production UI", async () => {
  const values = new Map<string, string>();
  selectAppStorage({get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);},
    removeItem: key => {values.delete(key);}, clear: () => values.clear()});
  const manuscriptId = crypto.randomUUID(), conversationId = crypto.randomUUID(), inputId = crypto.randomUUID(), tailId = crypto.randomUUID();
  const storage = new WritingDiffDemoStorage(manuscriptId, []), agent = new WritingDiffDemoAgentStorage(storage, undefined);
  const runtime = createWritingDiffDemoRuntime(storage, agent, manuscriptId, conversationId);
  runtime.setCompactionDuration(0); runtime.compaction.nextOutcome = "failed";
  let queue = await runtime.queue.gateway.read({conversationId, manuscriptId});
  for (const [id, text] of [[inputId, "/compact"], [tailId, "保留队尾消息"]] as const) queue = await runtime.queue.gateway.edit({
    conversationId, manuscriptId, requestId: crypto.randomUUID(), expectedRevision: queue.revision, edit: {type: "add", inputId: id, text, userInput: []},
  });
  const prepared = await runtime.compaction.gateway.prepareWritingQueued({inputId, previousRequestId: null,
    expectedQueueRevision: queue.revision, expectedRevision: 0, submission: {conversationId, requestId: crypto.randomUUID(), text: "/compact", userInput: [],
      context: {manuscriptId, files: []}, model: {providerId: "deepseek", modelId: "deepseek-v4-pro"}}});
  const entered = deferred<AgentWritingQueuedCompactionSettleRequest>(), release = deferred<void>();
  const settle = runtime.compaction.gateway.settleWritingQueued;
  vi.spyOn(runtime.compaction.gateway, "settleWritingQueued").mockImplementation(async request => {
    entered.resolve(request); await release.promise; return settle(request);
  });
  const reads: AgentWritingQueueResponse[] = [], read = runtime.queue.gateway.read;
  vi.spyOn(runtime.queue.gateway, "read").mockImplementation(async scope => {const value = await read(scope); reads.push(value); return value;});
  const start = vi.spyOn(runtime.compaction.gateway, "start");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const history = useAgentConversation(conversationId, undefined, runtime.history);
    const messages = useMemo(() => projectConversationMessages(history.projection), [history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} manuscriptId={manuscriptId} conversationId={conversationId}
      conversationTitle="合成压缩恢复" activePath={undefined} content="" contentHash={undefined} files={[]} messages={messages}
      projection={history.projection} historyReady={history.status === "ready"} open onOpenChange={() => {}}/>;
  }
  const button = (label: string) => [...host.querySelectorAll("button")].find(item => item.textContent === label)!;
  try {
    await act(async () => root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
    await vi.waitFor(() => expect(button("处理消息")?.disabled).toBe(false));
    expect(start).not.toHaveBeenCalled();
    await act(async () => button("处理消息").click());
    await vi.waitFor(() => expect(button("确认并继续原压缩请求")).toBeDefined());
    expect(start).not.toHaveBeenCalled();
    await act(async () => {button("确认并继续原压缩请求").click(); await entered.promise;});
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId: prepared.requestId}));
    expect(reads.at(-1)?.preparingInputId).toBe(inputId);
    expect(host.textContent).toContain("消息发送状态待确认");
    const beforeAck = reads.length;
    await act(async () => release.resolve());
    const settled = await read({conversationId, manuscriptId});
    expect(settled).toMatchObject({paused: true, preparingInputId: null});
    expect(settled.inputs.map(item => item.inputId)).toEqual([inputId, tailId]);
    await vi.waitFor(async () => {await act(async () => Promise.resolve());
      expect(host.textContent).not.toContain("消息发送状态待确认");
      expect(host.querySelector<HTMLButtonElement>('[aria-label="用第 1 条消息启动新轮次"]')?.disabled).toBe(false);
      expect(host.querySelector<HTMLButtonElement>('[aria-label="移除第 1 条消息"]')?.disabled).toBe(false);
    });
    expect(reads.length).toBeGreaterThan(beforeAck); expect(reads.at(-1)?.revision).toBe(settled.revision);
    expect([...host.querySelectorAll(".agent-input-queue-body li p")].map(row => row.textContent)).toEqual(["/compact", "保留队尾消息"]);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); host.remove(); runtime.dispose(); resetWritingCompactionOwnersForTests(); vi.restoreAllMocks();
  }
});
