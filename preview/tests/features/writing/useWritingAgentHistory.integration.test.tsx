/** @vitest-environment happy-dom */
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWritingAgentHistory, type WritingAgentHistoryAccess } from "@research-assistant/writing-projects-preview/use-writing-agent-history";
import { WritingDiffDemoHistory } from "@research-assistant/workbench-preview/writing-diff-demo-history";
import { resetAgentConversationProjectionCacheForTests } from "@research-assistant/workbench-preview/use-agent-conversation";
import { initialChanges } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-preview/writing-submission-controller";

const native = vi.hoisted(() => vi.fn(() => { throw new Error("Unexpected desktop IPC"); }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native }));
vi.mock("@research-assistant/workbench-preview/notifications", () => ({ notify: { error: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const manuscriptId = "00000000-0000-4000-8000-000000000003";
const conversationId = "00000000-0000-4000-8000-000000000001";
const admission = (id = conversationId): WritingSubmissionAdmission => ({ scope: { manuscriptId, conversationId: id,
  requestId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID() }, turnId: crypto.randomUUID() });
function backend(identity: string) {
  const history = new WritingDiffDemoHistory();
  let selected: string | null = conversationId;
  const access: WritingAgentHistoryAccess = { identity, gateway: history.gateway,
    metadata: { read: vi.fn(async ({ id }) => ({ id, title: identity, archived: false, durableCount: 0, createdAt: "now", updatedAt: "now" })) },
    selection: { read: vi.fn(() => selected), write: vi.fn((_binding, id) => { selected = id; }), clear: vi.fn(() => { selected = null; }) },
  };
  return { history, access };
}
let root: Root, state: ReturnType<typeof useWritingAgentHistory>;
const histories: WritingDiffDemoHistory[] = [];
function Probe({ access }: { readonly access: WritingAgentHistoryAccess }) {
  state = useWritingAgentHistory(manuscriptId, access);
  return null;
}
beforeEach(() => {
  resetAgentConversationProjectionCacheForTests(); native.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const history of histories.splice(0)) history.dispose();
  expect(native).not.toHaveBeenCalled(); vi.restoreAllMocks();
});
async function settled(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); assertion(); });
}
function create(identity: string) { const value = backend(identity); histories.push(value.history); return value; }

it("projects item completion separately from durable turn completion", async () => {
  const { history, access } = create("turn-metadata");
  const current = admission();
  history.start(current, "use a skill");
  history.resourceRound(current, [], [{ identity: { environment_id: "application", source_id: "review", revision: "1" }, name: "Review", contents: "Review instructions" }]);
  await act(async () => root.render(<Probe access={access} />));
  await settled(() => expect(state.messages.some(message => message.content === "工具结果已接收，继续处理。")).toBe(true));
  const commentary = state.messages.find(message => message.content === "工具结果已接收，继续处理。")!;
  expect("streaming" in commentary && commentary.streaming).toBe(false);
  expect(commentary.turnFinished).toBe(false);
  await act(async () => history.complete(current, []));
  await settled(() => expect(state.messages.every(message => message.turnFinished)).toBe(true));
  expect(state.messages.find(message => message.id === commentary.id)?.content).toBe(commentary.content);
  expect(state.messages.at(-1)?.content).toBe("已准备 0 个文件的修改。");
});

it("projects live durable messages and catches up after chat close and A/B selection", async () => {
  const { history, access } = create("first");
  const first = admission();
  history.start(first, "first request");
  await act(async () => root.render(<Probe access={access} />));
  await settled(() => expect(state.messages.map(({ content }) => content)).toEqual(["first request"]));
  expect(state.conversation.projection?.activeTurn).toBe(first.turnId);
  await act(async () => state.setOpen(false));
  await act(async () => history.complete(first, initialChanges));
  await settled(() => expect(state.conversation.projection?.turns.get(first.turnId)?.outcome).toBe("completed"));
  expect(state.messages.filter((message) => "kind" in message && message.kind === "tool-call")).toHaveLength(1);
  expect(state.messages.filter(({ role }) => role === "user")).toHaveLength(1);
  const frozen = await history.gateway.readHistory({ conversationId, afterSeq: 0, limit: 100 });
  const other = admission(crypto.randomUUID());
  await act(async () => state.select(other.scope.conversationId));
  await settled(() => expect(state.conversation.status).toBe("ready"));
  expect(state.messages).toHaveLength(0);
  const second = admission();
  await act(async () => { history.start(second, "while A detached"); history.complete(second, []); });
  expect(state.messages).toHaveLength(0);
  await act(async () => state.select(conversationId));
  await settled(() => expect(state.messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual(["first request", "while A detached"]));
  expect((await history.gateway.readHistory({ conversationId, afterSeq: 0, limit: frozen.events.length })).events).toEqual(frozen.events);
  await act(async () => state.setOpen(true));
  await settled(() => expect(state.conversation.status).toBe("ready"));
  expect(state.messages.filter(({ role }) => role === "user")).toHaveLength(2);
});

it("never lends a cached projection or pending selection to another storage with identical IDs", async () => {
  const first = create("old"), next = create("reset");
  first.history.complete(admission(), initialChanges);
  await act(async () => root.render(<Probe access={first.access} />));
  await settled(() => expect(state.conversation.projection?.seq).toBeGreaterThan(0));
  const old = state;
  await act(async () => root.render(<Probe access={next.access} />));
  expect(state.selectedId).toBeNull(); expect(state.messages).toEqual([]);
  await act(async () => state.select(conversationId));
  await settled(() => expect(state.conversation.status).toBe("ready"));
  expect(state.conversation.projection?.seq).toBe(0); expect(state.messages).toEqual([]);
  const reads = vi.mocked(next.access.metadata.read).mock.calls.length;
  await act(async () => { old.deleted(conversationId); old.setArchived(conversationId, true); });
  expect(state.selectedId).toBe(conversationId);
  expect(vi.mocked(next.access.metadata.read).mock.calls).toHaveLength(reads);
  const pending = crypto.randomUUID();
  await act(async () => state.select(pending, false, undefined, true));
  expect(state.pendingConversationId).toBe(pending);
  await act(async () => root.render(<Probe access={first.access} />));
  expect(state.pendingConversationId).toBeNull(); expect(state.messages).toEqual([]);
});

it("reattaches from the accepted sequence in the same storage without replaying messages", async () => {
  const { history, access } = create("persistent");
  history.complete(admission(), []);
  const read = vi.spyOn(history.gateway, "readHistory");
  await act(async () => root.render(<Probe access={access} />));
  await settled(() => expect(state.conversation.status).toBe("ready"));
  const seq = state.conversation.projection!.seq;
  await act(async () => root.render(null));
  const next = admission(); history.start(next, "detached"); history.complete(next, []);
  read.mockClear();
  await act(async () => root.render(<Probe access={access} />));
  await settled(() => expect(state.messages.filter(({ role }) => role === "user")).toHaveLength(2));
  expect(read.mock.calls[0]?.[0].afterSeq).toBe(seq);
});

it("does not expose old ready metadata for a replacement gateway before layout effects", async () => {
  const first = create("old"), next = create("new");
  const observations: string[] = [];
  function Observe({ access }: { readonly access: WritingAgentHistoryAccess }) {
    const value = useWritingAgentHistory(manuscriptId, access);
    useLayoutEffect(() => { observations.push(`${value.metadata.status}:${value.metadata.conversation?.title ?? "none"}`); });
    return null;
  }
  await act(async () => root.render(<Observe access={first.access} />));
  expect(observations.at(-1)).toBe("ready:old");
  // Preserve the same cache identity and selection while replacing only I/O.
  observations.length = 0;
  await act(async () => root.render(<Observe access={{ ...next.access, identity: "old" }} />));
  expect(observations[0]).toBe("loading:none"); expect(observations.at(-1)).toBe("ready:new");
});
