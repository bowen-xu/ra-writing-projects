/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useWritingAgentHistory } from "@research-assistant/writing-projects-preview/use-writing-agent-history";
import { useAgentConversation } from "@research-assistant/workbench-preview/use-agent-conversation";
import { useConversationMetadata } from "@research-assistant/workbench-preview/use-conversation-metadata";
import type { AgentConversationProjection, AgentSearchHit } from "@research-assistant/core/agent";
vi.mock("@research-assistant/workbench-preview/use-agent-conversation", () => ({ useAgentConversation: vi.fn(() => ({ status: "ready", projection: null, error: null })) }));
vi.mock("@research-assistant/workbench-preview/use-conversation-metadata", () => ({ useConversationMetadata: vi.fn(() => ({ status: "ready", conversation: null, refresh: vi.fn() })) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each(["completed", "canceled", "interrupted"] as const)("preserves %s outcome and timing while filtering empty envelopes", async outcome => {
  const projection = {
    conversationId: "one", seq: 1, activeTurn: null, turnOrder: ["turn"],
    turns: new Map([["turn", {
      contextSnapshotId: "context", model: { providerId: "provider", modelId: "model", revision: null },
      startedAtMs: 1_000, finishedAtMs: 8_800,
      phase: "runningTools", outcome, itemOrder: ["empty", "call"],
      items: new Map([
        ["empty", { kind: { type: "assistantMessage" }, text: "", completed: true, interrupted: false }],
        ["call", { kind: { type: "toolCall", callId: "call", name: "read" }, text: "{}", completed: true, interrupted: false }],
      ]),
      attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null,
    }]]),
  } as AgentConversationProjection;
  vi.mocked(useAgentConversation).mockReturnValue({ status: "ready", projection, error: null } as never);
  let state!: ReturnType<typeof useWritingAgentHistory>;
  function Probe() { state = useWritingAgentHistory("one"); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    expect(state.messages.map((message) => message.id)).toEqual(["turn/call"]);
    expect(state.messages[0]).toMatchObject({ turnStartedAtMs: 1_000, turnFinishedAtMs: 8_800, turnOutcome: outcome });
  } finally {
    await act(async () => root.unmount());
    vi.mocked(useAgentConversation).mockReturnValue({ status: "ready", projection: null, error: null } as never);
  }
});
it("clears only the deleted active conversation without selecting or starting another", async () => {
  let state!: ReturnType<typeof useWritingAgentHistory>;
  function Probe() { state = useWritingAgentHistory("one"); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => state.select("a", true));
    await act(async () => state.deleted("b"));
    expect(state.selectedId).toBe("a"); expect(state.isOpen).toBe(true);
    await act(async () => state.deleted("a"));
    expect(state.selectedId).toBeNull(); expect(state.isOpen).toBe(false); expect(state.hasCurrentConversation).toBe(false);
    expect(state.searchTarget).toBeNull(); expect(state.revealedConversation).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
it("explicitly opens a returned branch in its host and respects an archived replay", async () => {
  let state!: ReturnType<typeof useWritingAgentHistory>;
  function Probe({ id }: { id: string }) { state = useWritingAgentHistory(id); return null; }
  const root = createRoot(document.createElement("div"));
  const child = { id: "child", title: "Branch", archived: true, durableCount: 5, createdAt: "now", updatedAt: "now" };
  try {
    await act(async () => root.render(<Probe id="one" />));
    await act(async () => state.select("parent"));
    expect(state.revealedConversation).toBeNull();
    await act(async () => state.openRelatedConversation(child));
    expect(state.selectedId).toBe("child"); expect(state.isArchived).toBe(true); expect(state.isOpen).toBe(true);
    expect(state.revealedConversation).toBe(child); expect(state.searchTarget).toBeNull();
    await act(async () => state.openRelatedConversation(child, "boundary"));
    expect(state.searchTarget?.turnId).toBe("boundary"); expect(state.searchTarget?.messageId).toBeUndefined();
    await act(async () => state.select("parent")); expect(state.revealedConversation).toBeNull();
    await act(async () => root.render(<Probe id="two" />));
    expect(state.selectedId).toBeNull(); expect(state.revealedConversation).toBeNull(); expect(state.isOpen).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
it("owns search targets by manuscript and explicit selection, without inventing a title anchor", async () => {
  let state!: ReturnType<typeof useWritingAgentHistory>;
  function Probe({ id }: { id: string }) { state = useWritingAgentHistory(id); return null; }
  const root = createRoot(document.createElement("div"));
  const hit: AgentSearchHit = { conversation: { id: "a", title: "Saved", archived: false, durableCount: 10,
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" },
    excerpt: "Saved", itemId: "item", turnId: "turn", startSeq: 2, completed: true };
  try {
    await act(async () => root.render(<Probe id="one" />));
    await act(async () => state.select("a", false, hit));
    expect(state.searchTarget?.messageId).toBe("turn/item");
    const target = state.searchTarget;
    await act(async () => state.select("a", false, hit));
    expect(state.searchTarget).not.toEqual(target);
    await act(async () => state.select("b", false, hit));
    expect(state.searchTarget).toBeNull();
    await act(async () => state.select("a", false, { ...hit, itemId: null, turnId: null, startSeq: null }));
    expect(state.searchTarget).toBeNull();
    await act(async () => state.select("a", false, hit));
    await act(async () => root.render(<Probe id="two" />));
    expect(state.searchTarget).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
it("keeps archive state per conversation without reopening the selected history", async () => {
  let state!: ReturnType<typeof useWritingAgentHistory>;
  function Probe({ manuscriptId }: { manuscriptId: string }) { state = useWritingAgentHistory(manuscriptId); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe manuscriptId="one" />));
    await act(async () => state.select("a", true));
    expect(state.isArchived).toBe(true);
    const activation = vi.mocked(useAgentConversation).mock.calls.at(-1)?.[1];
    await act(async () => state.setArchived("b", true));
    expect(state.isArchived).toBe(true);
    expect(vi.mocked(useAgentConversation).mock.calls.at(-1)?.[1]).toBe(activation);
    await act(async () => state.setArchived("a", false));
    expect(state.isArchived).toBe(false);
    expect(vi.mocked(useAgentConversation).mock.calls.at(-1)?.[1]).toBe(activation);
    const finishEarlierMutation = state.setArchived;
    await act(async () => state.select("b"));
    const refresh = vi.mocked(useConversationMetadata).mock.results.at(-1)!.value.refresh;
    await act(async () => finishEarlierMutation("b", true));
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => root.render(<Probe manuscriptId="two" />));
    expect(state.selectedId).toBeNull(); expect(state.isArchived).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
