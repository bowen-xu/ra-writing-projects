/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentConversationProjection, type AgentConversationProjection, type AgentTurnProjection, type AgentWorkspaceScope } from "@research-assistant/core/agent";
import type { AgentWorkspaceReviewGateway } from "@research-assistant/data/agent";
import { useWritingTurnChangeScopes } from "./useWritingTurnChangeScopes";

const conversationId = "conversation", manuscriptId = "manuscript";
const scope = (requestId: string, contextSnapshotId = requestId): AgentWorkspaceScope => ({ conversationId, manuscriptId, requestId, contextSnapshotId });
function projection(entries: readonly (readonly [string, string, boolean])[], id = conversationId): AgentConversationProjection {
  return { ...createAgentConversationProjection(id), turnOrder: entries.map(([id]) => id),
    turns: new Map(entries.map(([id, contextSnapshotId, finished]) => [id, {
      contextSnapshotId, outcome: finished ? "completed" : null, phase: "runningModel", model: { providerId: "mock", modelId: "mock", revision: null },
      itemOrder: [], items: new Map(), attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null,
    } satisfies AgentTurnProjection])) };
}
let root: Root, host: HTMLDivElement;
let result: ReturnType<typeof useWritingTurnChangeScopes>;
const list = vi.fn<AgentWorkspaceReviewGateway["list"]>();
const gateway: AgentWorkspaceReviewGateway = { list, review: vi.fn(), reviewBinding: vi.fn(), readFile: vi.fn() };
function Harness({ value, id = conversationId }: { readonly value: AgentConversationProjection; readonly id?: string }) {
  result = useWritingTurnChangeScopes({ conversationId: id, manuscriptId, projection: value, gateway, fileSessions: undefined });
  return null;
}
const render = async (value: AgentConversationProjection, id = conversationId) => { await act(async () => root.render(<Harness value={value} id={id} />)); };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  list.mockReset(); vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("rebuilds confirmed change identities after a fresh mount without a live file session", async () => {
  const publishedProposalId = "11111111-1111-4111-8111-111111111111";
  list.mockResolvedValue({schemaVersion:1,entries:[{turnId:"saved",scope:scope("saved"),createdAt:"now",publishedProposalId}],nextCursor:null});
  const value = projection([["saved","saved",true]]);
  await render(value);
  expect(result.publishedProposals.get("saved")).toBe(publishedProposalId);
  await act(async () => root.render(null));
  await render(value);
  expect(result.scopes.get("saved")).toEqual(scope("saved"));
  expect(result.publishedProposals.get("saved")).toBe(publishedProposalId);
});

it("restores all paginated changes by turn and snapshot, ignoring active or unrelated entries", async () => {
  list.mockImplementation(async request => ({ schemaVersion: 1, entries: request.cursor === null
    ? [{ turnId: "new", scope: scope("new"), createdAt: "now" }, { turnId: "wrong", scope: scope("other"), createdAt: "now" }]
    : [{ turnId: "old", scope: scope("old"), createdAt: "before" }], nextCursor: request.cursor === null ? "other" : null }));
  await render(projection([["old", "old", true], ["new", "new", true], ["wrong", "wrong", true]]));
  expect([...result.scopes.keys()]).toEqual(["new", "old"]);
  expect(list).toHaveBeenCalledTimes(2);
  const existing = result.scopes;
  await render(projection([["old", "old", true], ["new", "new", true], ["wrong", "wrong", true], ["running", "running", false]]));
  expect(result.scopes).toBe(existing);
  expect(list).toHaveBeenCalledTimes(2);
});

it("retains earlier identities during another completion and a failed refresh, then retries", async () => {
  list.mockResolvedValue({ schemaVersion: 1, entries: [{ turnId: "old", scope: scope("old"), createdAt: "now" }], nextCursor: null });
  await render(projection([["old", "old", true]]));
  const existing = result.scopes;
  list.mockRejectedValueOnce(new Error("unavailable"));
  await render(projection([["old", "old", true], ["new", "new", true]]));
  expect(result.scopes).toBe(existing); expect(result.failed).toBe(true);
  list.mockResolvedValue({ schemaVersion: 1, entries: [{ turnId: "new", scope: scope("new"), createdAt: "now" },
    { turnId: "old", scope: scope("old"), createdAt: "before" }], nextCursor: null });
  await act(async () => result.retry());
  expect(result.failed).toBe(false); expect(result.scopes.get("old")).toEqual(scope("old"));
  expect(result.scopes.get("new")).toEqual(scope("new"));
});

it("exposes one history lookup failure with a retry and keeps existing summaries", async () => {
  list.mockResolvedValueOnce({ schemaVersion: 1, entries: [{ turnId: "old", scope: scope("old"), createdAt: "now" }], nextCursor: null });
  await render(projection([["old", "old", true]]));
  const existing = result.scopes;
  list.mockRejectedValueOnce({code: "DATA_READ_FAILURE", requestId: "request-123", status: 503});
  await render(projection([["old", "old", true], ["new", "new", true], ["third", "third", true]]));
  expect(result.scopes).toBe(existing);
  expect(result.error).toContain("code=DATA_READ_FAILURE");
  expect(result.error).toContain("request=request-123");
  list.mockResolvedValueOnce({ schemaVersion: 1, entries: [{ turnId: "new", scope: scope("new"), createdAt: "now" }], nextCursor: null });
  await act(async () => result.retry());
  expect(result.scopes.get("new")).toEqual(scope("new"));
  expect(result.failed).toBe(false);
  expect(result.error).toBeNull();
});

it("never returns another conversation's scopes while the new lookup is pending or fails", async () => {
  list.mockResolvedValueOnce({ schemaVersion: 1, entries: [{ turnId: "shared", scope: scope("old"), createdAt: "now" }], nextCursor: null });
  await render(projection([["shared", "old", true]]));
  expect(result.scopes.get("shared")).toEqual(scope("old"));
  let rejectLookup!: (reason: unknown) => void;
  list.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLookup = reject; }));
  await render(projection([["shared", "new", true]], "other-conversation"), "other-conversation");
  expect(result.scopes.size).toBe(0);
  await act(async () => rejectLookup(new Error("read failed")));
  expect(result.scopes.size).toBe(0);
  expect(result.failed).toBe(true);
});
