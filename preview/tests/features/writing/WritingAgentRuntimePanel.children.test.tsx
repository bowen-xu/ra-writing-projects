/** @vitest-environment happy-dom */
import { mocks, id, WritingAgentRuntimePanel } from "./WritingAgentRuntimePanel.test-harness.tsx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AgentConversationProjection, AgentForkRequest } from "@research-assistant/core/agent";

it("creates a branch at the last message, keeps source draft and offers explicit open without submitting", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const turnId = "22222222-2222-4222-8222-222222222222", epoch = "33333333-3333-4333-8333-333333333333";
  const child = (childId: string) => ({ id: childId, title: "Branch", archived: false, durableCount: 5, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" });
  let committed = false;
  mocks.forkStatus.mockImplementation(async (request: AgentForkRequest) => ({ schemaVersion: 1, operationId: request.childId, conversationId: request.childId,
    status: committed ? { type: "committed", proof: { schemaVersion: 1, operationId: request.childId, conversationId: request.childId, family: "agent.conversation.fork", epoch, sqlFence: "5", replayed: true, result: null } }
      : { type: "noSqlReceipt", epoch, sqlFence: "5", closed: false } }));
  mocks.fork.mockImplementation(async (request: AgentForkRequest) => { committed = true; return { schemaVersion: 1, conversation: child(request.childId), parentId: id, throughTurnId: turnId, parentEndSeq: 5 }; });
  mocks.metadataRead.mockImplementation(async (request: { id: string }) => child(request.id));
  const previousLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) } });
  const projection: AgentConversationProjection = { conversationId: id, seq: 5, activeTurn: null, turnOrder: [turnId], turns: new Map([[turnId, {
    contextSnapshotId: "snapshot", model: { providerId: "test", modelId: "test", revision: null }, phase: "preparing", outcome: "completed",
    itemOrder: ["user", "answer"], items: new Map(), attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null,
  }]]) };
  const onOpen = vi.fn();
  const render = (open = true, archived = true) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash" files={[]} projection={projection} historyReady open={open} archived={archived}
    messages={[{ id: `${turnId}/user`, role: "user", content: "Question" }, { id: `${turnId}/answer`, role: "assistant", content: "Answer" }]}
    onOpenChange={() => undefined} onOpenConversation={onOpen} />);
  try {
    await act(async () => render(true, false)); const input = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Source draft"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => render());
    expect(input.disabled).toBe(true);
    expect(container.querySelector(`[data-agent-message-id="${turnId}/user"] .conversation-fork-control button`)).toBeNull();
    const fork = container.querySelector<HTMLButtonElement>(`[data-agent-message-id="${turnId}/answer"] .conversation-fork-control button`)!;
    fork.focus(); await act(async () => fork.click());
    expect(onOpen).not.toHaveBeenCalled(); expect(document.activeElement).toBe(fork); expect(input.value).toBe("Source draft");
    expect(container.querySelector("textarea")).toBe(input); expect(fork.textContent).toContain("打开分支");
    await act(async () => render(false)); await act(async () => render());
    expect(container.querySelector("textarea")?.value).toBe("Source draft");
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-agent-message-id="${turnId}/answer"] .conversation-fork-control button`)!.click());
    const request = mocks.fork.mock.calls[0]![0] as AgentForkRequest;
    expect(onOpen).toHaveBeenCalledWith(child(request.childId)); expect(mocks.fork).toHaveBeenCalledOnce();
    expect(mocks.forkStatus).toHaveBeenCalledTimes(2);
    expect(mocks.forkStatus.mock.calls.map(([intent]) => intent)).toEqual([request, request]);
    expect(mocks.fork.mock.calls[0]![1]).toEqual({ expectedEpoch: epoch });
    expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); if (previousLocks) Object.defineProperty(navigator, "locks", previousLocks); else Reflect.deleteProperty(navigator, "locks"); }
});

it("drops a late writing child recovery result after switching conversations", async () => {
  vi.clearAllMocks();
  const childId = "child-recovery";
  mocks.childList.mockResolvedValue([{ schemaVersion: 1, childConversationId: childId, parentConversationId: id, parentContextSnapshotId: id, childContextSnapshotId: childId, depth: 1, modelCalls: 1, toolCalls: 1, status: "recovery_required", createdAt: "now", finishedAt: "now" }]);
  let resolve!: () => void;
  mocks.resumeWriting.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (conversationId: string) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={conversationId}
    conversationTitle="Paper" activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]}
    projection={null} historyReady open onOpenChange={() => undefined} />);
  try {
    await act(async () => render(id));
    await act(async () => Promise.resolve());
    const before = mocks.childList.mock.calls.length;
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "恢复并继续")?.click());
    await act(async () => render("22222222-2222-4222-8222-222222222222"));
    const afterSwitch = mocks.childList.mock.calls.length;
    await act(async () => { resolve(); await Promise.resolve(); });
    expect(afterSwitch).toBeGreaterThan(before);
    expect(mocks.childList.mock.calls.length).toBe(afterSwitch);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("refreshes a running child task on focus without polling", async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const childId = "child-running";
  const running = { schemaVersion: 1 as const, childConversationId: childId, parentConversationId: id, parentContextSnapshotId: id, childContextSnapshotId: childId, depth: 1, modelCalls: 1, toolCalls: 1, status: "running" as const, createdAt: "now", finishedAt: null };
  const completed = { ...running, status: "completed" as const, finishedAt: "later" };
  mocks.childList.mockResolvedValue([running]);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={null}
      historyReady open onOpenChange={() => undefined} />));
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("运行中");
    mocks.childList.mockResolvedValue([completed]);
    const reads = mocks.childList.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(mocks.childList).toHaveBeenCalledTimes(reads);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(container.textContent).toContain("已完成");
    expect(container.textContent).not.toContain("运行中");
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
  }
});
