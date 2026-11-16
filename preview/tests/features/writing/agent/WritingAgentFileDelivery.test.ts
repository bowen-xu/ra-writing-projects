import { afterEach, expect, it, vi } from "vitest";
import { decodeAgentEvent, type AgentApplicationScope, type AgentHistoryResponse, type AgentProposalReview, type AgentWorkspaceReview, type AgentHistoryWaitResponse } from "@research-assistant/core/agent";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-preview/writing-submission-controller";
import { WritingAgentFileDelivery } from "@research-assistant/writing-projects-preview/writing-agent-file-delivery";
import { WritingDeliveryConflict } from "@research-assistant/writing-projects-preview/writing-delivery-conflict";
import { createAgentApplicationGateway } from "@research-assistant/data/agent";
import { createWritingProposalApplication } from "@research-assistant/writing-projects-preview/writing-proposal-application";
import type { EditorApplicationResult } from "@research-assistant/writing-projects-preview/editor-application";
import raw from "../../../fixtures/agent-events-v1.json";

const events = raw.map(decodeAgentEvent), first = events[0]!;
const completedSeq = events.find(event => event.payload.type === "turnFinished" && event.payload.outcome === "completed")?.seq ?? 0;
const admission: WritingSubmissionAdmission = { scope: { manuscriptId: "00000000-0000-4000-8000-000000000010", conversationId: first.conversationId,
  requestId: first.requestId!, contextSnapshotId: "00000000-0000-0000-0000-000000000003" }, turnId: "00000000-0000-0000-0000-000000000002" };
const review: AgentWorkspaceReview = { schemaVersion: 1, binding: { scope: admission.scope, turnId: admission.turnId,
  leaseId: "lease", manifestHash: "a".repeat(64) }, changes: [{ path: "main.tex", kind: "modified", hasEditorBuffer: true,
    before: { sha256: "b".repeat(64), byteSize: 3, executable: false }, after: { sha256: "c".repeat(64), byteSize: 3, executable: false } }] };
const proposal: AgentProposalReview = { schemaVersion: 1, proposalId: "00000000-0000-4000-8000-000000000011", status: "pending", review };
const receivers: WritingAgentFileDelivery[] = [];
afterEach(() => { for (const receiver of receivers.splice(0)) receiver.dispose(); });
function setup(complete = true, overrides: Partial<ConstructorParameters<typeof WritingAgentFileDelivery>[0]> = {}) {
  let ready = true;
  const response = (afterSeq: number, end: number): AgentHistoryResponse => ({ schemaVersion: 1,
    conversationId: first.conversationId, watermark: end, afterSeq, nextAfterSeq: null, events: events.slice(afterSeq, end) });
  let release!: (value: AgentHistoryWaitResponse) => void;
  const notice = new Promise<AgentHistoryWaitResponse>((resolve) => { release = resolve; });
  const sessions = { create: vi.fn(), open: vi.fn(async () => ({ schemaVersion: 1 as const, conversationId: first.conversationId, watermark: complete ? completedSeq : completedSeq - 1 })),
    readHistory: vi.fn(async (request: { afterSeq: number }) => response(request.afterSeq, complete ? completedSeq : completedSeq - 1)), waitForHistory: vi.fn(() => notice) };
  const proposals = { latest: vi.fn(async (): Promise<AgentProposalReview | null> => null), publish: vi.fn(async () => proposal) };
  const reviews = { review: vi.fn(async () => review), reviewBinding: vi.fn(async () => review) }, prepareFiles = vi.fn(async () => undefined);
  const accept = vi.fn(async (scope: AgentApplicationScope): Promise<EditorApplicationResult> => ({ kind: "state", state: { kind: "state", schemaVersion: 1, scope, status: "applied", files: [] } }));
  const acknowledge = vi.fn(async () => undefined);
  const receiver = new WritingAgentFileDelivery({ sessions, proposals, reviews, prepareFiles, accept, acknowledge, canApply: () => ready, ...overrides });
  receivers.push(receiver);
  return { receiver, proposals, reviews, sessions, prepareFiles, accept, acknowledge, setReady: (value: boolean) => { ready = value; }, complete: () => {
    complete = true; release({ schemaVersion: 1, conversationId: first.conversationId, afterSeq: completedSeq - 1, watermark: completedSeq });
  } };
}
it("receives a tracked completed turn without any chat view and deduplicates registration", async () => {
  const f = setup();
  f.receiver.register(admission); f.receiver.register(admission);
  await vi.waitFor(() => expect(f.accept).toHaveBeenCalledOnce());
  expect(f.prepareFiles).toHaveBeenCalledWith(proposal);
  expect(f.prepareFiles.mock.invocationCallOrder[0]).toBeLessThan(f.accept.mock.invocationCallOrder[0]!);
  expect(f.accept).toHaveBeenCalledWith({ manuscriptId: admission.scope.manuscriptId, conversationId: first.conversationId, proposalId: proposal.proposalId, operationId: expect.any(String) });
  expect(f.receiver.getSnapshot()).toEqual([]);
  f.receiver.register(admission);
  expect(f.sessions.open).toHaveBeenCalledOnce();
  expect(f.accept).toHaveBeenCalledOnce();
});

it("returns a live delivery failure to the waiting tool before the turn ends", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  f.accept.mockResolvedValue({ kind: "unconfirmed", state: null });
  const request = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(request);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request, complete: false })));
  expect(f.acknowledge).not.toHaveBeenCalled();
  expect(f.receiver.getSnapshot()[0]?.status).toBe("error");
});

it("never applies another lease's proposal to a live delivery request", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  f.proposals.latest.mockResolvedValue(proposal);
  const request = { ...admission, requestId: crypto.randomUUID(), binding: { ...review.binding, leaseId: "another-lease" } };
  f.receiver.requestTool(request);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request, complete: false })));
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.prepareFiles).not.toHaveBeenCalled();
});

it("saves inside the tool and acknowledges only after the Agent's final reply without reapplying", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  f.receiver.requestTool({ ...admission, requestId: crypto.randomUUID(), binding: review.binding });
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ complete: true })));
  expect(f.acknowledge).not.toHaveBeenCalled();
  f.complete();
  await vi.waitFor(() => expect(f.acknowledge).toHaveBeenCalledOnce());
  expect(f.accept).toHaveBeenCalledOnce();
});

it("does not report a new delivery request as confirmed using an earlier receipt", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  const first = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  const second = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(first);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: first, complete: true })));
  f.receiver.requestTool(second);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: second, complete: false })));
  expect(reportTool).not.toHaveBeenCalledWith(expect.objectContaining({ request: second, complete: true }));
  expect(f.receiver.getSnapshot()[0]).toMatchObject({ status: "error", failureStage: "files" });
  expect(f.accept).toHaveBeenCalledOnce();
});

it("delivers a later workspace with its own operation and preserves the earlier receipt", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  const first = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(first);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: first, complete: true })));
  const nextReview: AgentWorkspaceReview = { ...review, binding: { ...review.binding, leaseId: "successor", manifestHash: "d".repeat(64) } };
  const nextProposal: AgentProposalReview = { ...proposal, proposalId: "00000000-0000-4000-8000-000000000099", review: nextReview };
  f.proposals.latest.mockResolvedValue(proposal);
  f.reviews.reviewBinding.mockResolvedValue(nextReview);
  f.proposals.publish.mockResolvedValue(nextProposal);
  const second = { ...admission, requestId: crypto.randomUUID(), binding: nextReview.binding };
  f.receiver.requestTool(second);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: second, complete: true })));
  expect(f.reviews.reviewBinding).toHaveBeenCalledWith(nextReview.binding);
  expect(f.accept).toHaveBeenCalledTimes(2);
  expect(f.accept.mock.calls[0]![0].operationId).not.toBe(f.accept.mock.calls[1]![0].operationId);
  expect(f.accept.mock.calls[1]![0].proposalId).toBe(nextProposal.proposalId);
  f.receiver.requestTool(first);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledTimes(3));
  expect(reportTool).toHaveBeenLastCalledWith(expect.objectContaining({ request: first, complete: true }));
  expect(f.accept).toHaveBeenCalledTimes(2);
});

it("reconciles an unresolved operation on its original lease and refuses a different lease", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  f.accept.mockResolvedValueOnce({ kind: "unconfirmed", state: null });
  const first = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(first);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: first, complete: false })));
  const unrelated = { ...admission, requestId: crypto.randomUUID(), binding: { ...review.binding, leaseId: "other" } };
  f.receiver.requestTool(unrelated);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: unrelated, complete: false })));
  expect(f.accept).toHaveBeenCalledOnce();
  const retry = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(retry);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: retry, complete: true })));
  expect(f.accept).toHaveBeenCalledTimes(2);
  expect(f.accept.mock.calls[0]![0].operationId).toBe(f.accept.mock.calls[1]![0].operationId);
});

it("recognizes a repeated event only for the already confirmed delivery request", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  const request = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(request);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledTimes(1));
  f.receiver.requestTool(request);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledTimes(2));
  expect(reportTool).toHaveBeenLastCalledWith(expect.objectContaining({ request, complete: true }));
  expect(f.accept).toHaveBeenCalledOnce();
});

it("does not reuse a confirmed request id for a different workspace lease", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  const request = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(request);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request, complete: true })));
  const changed = { ...request, binding: { ...request.binding, leaseId: "different-lease" } };
  f.receiver.requestTool(changed);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: changed, complete: false })));
  expect(f.accept).toHaveBeenCalledOnce();
});

it("does not clear a later delivery failure when the old request is repeated", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  const first = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  const second = { ...admission, requestId: crypto.randomUUID(), binding: review.binding };
  f.receiver.requestTool(first);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: first, complete: true })));
  f.receiver.requestTool(second);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledWith(expect.objectContaining({ request: second, complete: false })));
  f.receiver.requestTool(first);
  await vi.waitFor(() => expect(reportTool).toHaveBeenCalledTimes(3));
  expect(reportTool).toHaveBeenLastCalledWith(expect.objectContaining({ request: first, complete: true }));
  expect(f.receiver.getSnapshot()[0]).toMatchObject({ status: "error", failureStage: "files" });
  expect(f.accept).toHaveBeenCalledOnce();
  expect(f.acknowledge).not.toHaveBeenCalled();
});

it("waits for history resynchronization before acknowledging a terminal observed during tool delivery", async () => {
  const reportTool = vi.fn(async () => undefined);
  const f = setup(false, { reportTool });
  let releaseAcceptance!: (result: EditorApplicationResult) => void;
  f.accept.mockImplementationOnce(() => new Promise(resolve => { releaseAcceptance = resolve; }));
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.sessions.waitForHistory).toHaveBeenCalledOnce());
  let finishRead!: (page: AgentHistoryResponse) => void;
  const resync = new Promise<AgentHistoryResponse>(resolve => { finishRead = resolve; });
  f.sessions.readHistory.mockImplementation(async ({ afterSeq }) => {
    if (afterSeq === completedSeq) return resync;
    return { schemaVersion: 1, conversationId: first.conversationId, watermark: completedSeq,
      afterSeq, nextAfterSeq: null, events: events.slice(afterSeq, completedSeq) };
  });
  f.sessions.waitForHistory.mockImplementation(() => new Promise(() => undefined));
  f.receiver.requestTool({ ...admission, requestId: crypto.randomUUID(), binding: review.binding });
  await vi.waitFor(() => expect(releaseAcceptance).toBeTypeOf("function"));
  f.complete();
  await vi.waitFor(() => expect(f.sessions.waitForHistory).toHaveBeenCalledTimes(2));
  const scope = f.accept.mock.calls[0]![0];
  releaseAcceptance({ kind: "state", state: { kind: "state", schemaVersion: 1, scope, status: "applied", files: [] } });
  await vi.waitFor(() => expect(f.sessions.readHistory).toHaveBeenCalledTimes(3));
  expect(f.acknowledge).not.toHaveBeenCalled();
  finishRead({ schemaVersion: 1, conversationId: first.conversationId, afterSeq: completedSeq,
    watermark: completedSeq, events: [], nextAfterSeq: null });
  await vi.waitFor(() => expect(f.acknowledge).toHaveBeenCalledOnce());
  expect(f.accept).toHaveBeenCalledOnce();
});

it("rejects a stale unapplied proposal without dispatch and only retries acknowledgement after a lost reply", async () => {
  const rejectProposal = vi.fn(async () => ({ ...proposal, status: "rejected" as const }));
  const findApplication = vi.fn(async () => null);
  const f = setup(true, { rejectProposal, findApplication });
  f.prepareFiles.mockRejectedValue(new WritingDeliveryConflict());
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]).toMatchObject({ status: "error", conflict: true }));
  expect(f.accept).not.toHaveBeenCalled();
  f.acknowledge.mockRejectedValueOnce(new Error("lost reply"));
  await f.receiver.discardConflict(admission);
  expect(f.receiver.getSnapshot()[0]).toMatchObject({ status: "error", failureStage: "acknowledgement" });
  expect(rejectProposal).toHaveBeenCalledOnce();
  f.receiver.retry(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()).toEqual([]));
  expect(f.acknowledge).toHaveBeenCalledTimes(2);
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.prepareFiles).toHaveBeenCalledOnce();
});

it("refuses to discard when an application journal has appeared since the conflict was observed", async () => {
  const rejectProposal = vi.fn();
  const application = { kind: "state" as const, schemaVersion: 1 as const, status: "recoveryRequired" as const,
    scope: { manuscriptId: admission.scope.manuscriptId, conversationId: admission.scope.conversationId,
      proposalId: proposal.proposalId, operationId: "original-operation" }, files: [] };
  const f = setup(true, { rejectProposal, findApplication: vi.fn(async () => application) });
  f.prepareFiles.mockRejectedValue(new WritingDeliveryConflict());
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.conflict).toBe(true));
  await f.receiver.discardConflict(admission);
  expect(rejectProposal).not.toHaveBeenCalled();
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.receiver.getSnapshot()[0]).toMatchObject({ status: "error", failureStage: "application", application });
  expect(f.receiver.getSnapshot()[0]?.conflict).toBeUndefined();
});

it("keeps a conflict pending after an unavailable journal lookup and ignores a late lookup after leaving the manuscript", async () => {
  let release!: (value: null) => void;
  const findApplication = vi.fn<NonNullable<ConstructorParameters<typeof WritingAgentFileDelivery>[0]["findApplication"]>>()
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const rejectProposal = vi.fn(async () => ({ ...proposal, status: "rejected" as const }));
  const f = setup(true, { findApplication, rejectProposal });
  f.prepareFiles.mockRejectedValue(new WritingDeliveryConflict());
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.conflict).toBe(true));
  await f.receiver.discardConflict(admission);
  expect(rejectProposal).not.toHaveBeenCalled();
  const discard = f.receiver.discardConflict(admission);
  f.setReady(false); release(null); await discard;
  expect(rejectProposal).not.toHaveBeenCalled();
  expect(f.receiver.getSnapshot()[0]).toMatchObject({ status: "error", conflict: true });
  expect(f.accept).not.toHaveBeenCalled();
});
it("does not change files from a running turn or from loading unrelated history", async () => {
  const f = setup(false);
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.sessions.waitForHistory).toHaveBeenCalledOnce());
  expect(f.accept).not.toHaveBeenCalled(); expect(f.reviews.review).not.toHaveBeenCalled();
  f.complete();
  await vi.waitFor(() => expect(f.accept).toHaveBeenCalledOnce());
});
it("retains completion while another manuscript is selected and resumes when its host is available", async () => {
  const f = setup(); f.setReady(false); f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("waiting"));
  expect(f.proposals.latest).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  f.setReady(true); f.receiver.resume();
  await vi.waitFor(() => expect(f.accept).toHaveBeenCalledOnce());
});
it("retries failed delivery with the same operation, never treating failure as completion", async () => {
  const f = setup(); f.accept.mockRejectedValueOnce(new Error("checkpoint unavailable"));
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("error"));
  f.receiver.resume(); expect(f.accept).toHaveBeenCalledOnce();
  f.receiver.retry(admission);
  await vi.waitFor(() => expect(f.accept).toHaveBeenCalledTimes(2));
  expect(f.accept.mock.calls[0]).toEqual(f.accept.mock.calls[1]);
});
it.each(["proposal", "files", "application", "acknowledgement"] as const)("identifies the %s failure without publishing private error text", async (stage) => {
  const f = setup();
  const error = new Error("private request content");
  if (stage === "proposal") f.proposals.latest.mockRejectedValueOnce(error);
  if (stage === "files") f.prepareFiles.mockRejectedValueOnce(error);
  if (stage === "application") f.accept.mockRejectedValueOnce(error);
  if (stage === "acknowledgement") f.acknowledge.mockRejectedValueOnce(error);
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("error"));
  expect(f.receiver.getSnapshot()[0]).toMatchObject({ failureStage: stage });
  expect(JSON.stringify(f.receiver.getSnapshot())).not.toContain(error.message);
  f.receiver.retry(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()).toEqual([]));
});
it.each(["rejected", "undone"] as const)("keeps %s history read-only after a repeated admission", async (status) => {
  const f = setup(); f.proposals.latest.mockResolvedValue({ ...proposal, status });
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()).toEqual([]));
  expect(f.proposals.publish).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
});
it("rejects a mismatched frozen proposal instead of applying another request's text", async () => {
  const f = setup(); f.proposals.latest.mockResolvedValue({ ...proposal, review: { ...review,
    binding: { ...review.binding, scope: { ...review.binding.scope, requestId: "other" } } } });
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("error"));
  expect(f.accept).not.toHaveBeenCalled(); expect(f.prepareFiles).not.toHaveBeenCalled();
});
it("fences late completion and proposal reads when the workspace disposes", async () => {
  const f = setup(); let release!: (value: AgentWorkspaceReview) => void;
  f.reviews.review.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  f.receiver.register(admission);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.receiver.dispose(); release(review); await Promise.resolve(); await Promise.resolve();
  expect(f.proposals.publish).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
});
it.each(["manuscriptId", "conversationId", "proposalId"] as const)("does not confirm an applied receipt with a different %s", async (field) => {
  const f = setup();
  f.accept.mockImplementationOnce(async (scope) => ({ kind: "state", state: { kind: "state", schemaVersion: 1,
    scope: { ...scope, [field]: "other-identity" }, status: "applied", files: [] } }));
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.accept).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("error"));
});
it("recognizes the native coordinator's original applied journal after a lost reply without replaying files", async () => {
  const f = setup();
  const originalScope = { manuscriptId: admission.scope.manuscriptId, conversationId: admission.scope.conversationId,
    proposalId: proposal.proposalId, operationId: "00000000-0000-4000-8000-000000000012" };
  const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => ({ kind: "state", schemaVersion: 1, scope: originalScope, status: "applied",
    files: [{ path: "main.tex", phase: "acknowledged", target: { kind: "disk" } }] }));
  const editor = { apply: vi.fn() }, acquire = vi.fn();
  const application = createWritingProposalApplication(createAgentApplicationGateway(invoke), editor, acquire);
  f.accept.mockImplementation(async (scope) => {
    const result = await application.apply(scope);
    // Model a response lost after the durable journal lookup completed.
    if (f.accept.mock.calls.length === 1) throw new Error("lost receipt");
    if (result.kind !== "state") throw new Error("missing native journal");
    return result;
  });
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("error"));
  f.receiver.retry(admission);
  await vi.waitFor(() => expect(f.accept).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(f.receiver.getSnapshot()).toEqual([]));
  expect(f.accept.mock.calls[0]).toEqual(f.accept.mock.calls[1]);
  expect(f.accept.mock.calls[0]?.[0].operationId).not.toBe(originalScope.operationId);
  expect(invoke.mock.calls.every(([command]) => command === "agent_find_writing_proposal_application")).toBe(true);
  expect(editor.apply).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
});
it("finishes a verified empty change list without publishing or applying", async () => {
  const f = setup(); f.reviews.review.mockResolvedValue({ ...review, changes: [] });
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.reviews.review).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.receiver.getSnapshot()).toEqual([]));
  expect(f.proposals.publish).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  expect(f.acknowledge).toHaveBeenCalledWith(admission);
});
it("keeps a failed durable acknowledgement pending and reconciles native application on explicit retry", async () => {
  const f = setup();
  const nativeScope = { manuscriptId: admission.scope.manuscriptId, conversationId: admission.scope.conversationId,
    proposalId: proposal.proposalId, operationId: "00000000-0000-4000-8000-000000000012" };
  const invoke = vi.fn(async () => ({ kind: "state", schemaVersion: 1, scope: nativeScope, status: "applied",
    files: [{ path: "main.tex", phase: "acknowledged", target: { kind: "disk" } }] }));
  const editor = { apply: vi.fn() }, acquire = vi.fn();
  const application = createWritingProposalApplication(createAgentApplicationGateway(invoke), editor, acquire);
  f.accept.mockImplementation(async (scope) => {
    const result = await application.apply(scope);
    if (result.kind !== "state") throw new Error("missing native application");
    return result;
  });
  f.acknowledge.mockRejectedValueOnce(new Error("lost acknowledgement"));
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("error"));
  f.receiver.resume(); expect(f.acknowledge).toHaveBeenCalledOnce();
  f.receiver.retry(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()).toEqual([]));
  expect(f.acknowledge).toHaveBeenCalledTimes(2);
  expect(editor.apply).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
});
it("does not publish a review with a different completed turn", async () => {
  const f = setup(); f.reviews.review.mockResolvedValue({ ...review, binding: { ...review.binding, turnId: "other-turn" } });
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.status).toBe("error"));
  expect(f.proposals.publish).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
});

it.each(["applied", "rolledBack"] as const)("keeps a read/save failure pending, then settles a protected %s result without reapplying", async status => {
  const f = setup();
  f.accept.mockImplementationOnce(async scope => ({ kind: "unconfirmed", state: { kind: "state", schemaVersion: 1, scope,
    status: "recoveryRequired", files: [{ path: "main.tex", phase: "acknowledged", target: { kind: "disk" } }] } }));
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.failureStage).toBe("application"));
  const original = f.receiver.getSnapshot()[0]!.application!;
  const terminal = { ...original, status, files: original.files.map(file => ({ ...file, phase: status === "applied" ? "acknowledged" as const : "restored" as const })) };
  await f.receiver.recordApplication(admission, { kind: "unconfirmed", state: terminal });
  expect(f.acknowledge).not.toHaveBeenCalled();
  expect(f.receiver.getSnapshot()[0]?.application).toEqual(terminal);
  await f.receiver.recordApplication(admission, { kind: "state", state: { ...terminal, scope: { ...terminal.scope, operationId: "foreign" } } });
  expect(f.acknowledge).not.toHaveBeenCalled();
  f.acknowledge.mockRejectedValueOnce(new Error("lost settlement"));
  await f.receiver.recordApplication(admission, { kind: "state", state: terminal });
  expect(f.receiver.getSnapshot()[0]).toMatchObject({ status: "error", failureStage: "acknowledgement" });
  f.receiver.retry(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()).toEqual([]));
  expect(f.acknowledge).toHaveBeenCalledTimes(2);
  expect(f.accept).toHaveBeenCalledOnce();
});
it("ignores recovery results from an old manuscript or a disposed receiver", async () => {
  const f = setup();
  f.accept.mockImplementationOnce(async scope => ({ kind: "unconfirmed", state: { kind: "state", schemaVersion: 1, scope, status: "recoveryRequired", files: [] } }));
  f.receiver.register(admission);
  await vi.waitFor(() => expect(f.receiver.getSnapshot()[0]?.application).toBeDefined());
  const state = { ...f.receiver.getSnapshot()[0]!.application!, status: "rolledBack" as const };
  f.setReady(false);
  await f.receiver.recordApplication(admission, { kind: "state", state });
  expect(f.acknowledge).not.toHaveBeenCalled();
  f.receiver.dispose(); f.setReady(true);
  await f.receiver.recordApplication(admission, { kind: "state", state });
  expect(f.acknowledge).not.toHaveBeenCalled();
});
it("observes a rolled-back native application on startup without settling before formal save", async () => {
  const f = setup(); f.proposals.latest.mockResolvedValue({ ...proposal, status: "undone" });
  const scope = { manuscriptId: admission.scope.manuscriptId, conversationId: admission.scope.conversationId,
    proposalId: proposal.proposalId, operationId: crypto.randomUUID() };
  const native = { kind: "state" as const, schemaVersion: 1 as const, scope, status: "rolledBack" as const,
    files: [{ path: "main.tex", phase: "restored" as const, target: { kind: "disk" as const } }] };
  const findApplication = vi.fn(async () => native);
  const receiver = new WritingAgentFileDelivery({ ...f, canApply: () => true, findApplication });
  receivers.push(receiver); receiver.register(admission);
  await vi.waitFor(() => expect(receiver.getSnapshot()[0]).toMatchObject({ status: "error", failureStage: "application", application: native }));
  expect(f.accept).not.toHaveBeenCalled(); expect(f.acknowledge).not.toHaveBeenCalled();
  expect(findApplication).toHaveBeenCalledExactlyOnceWith({ manuscriptId: scope.manuscriptId, conversationId: scope.conversationId, proposalId: scope.proposalId });
  await receiver.recordApplication(admission, { kind: "state", state: native });
  expect(receiver.getSnapshot()).toEqual([]); expect(f.acknowledge).toHaveBeenCalledOnce();
});

it.each(["applied", "rolledBack"] as const)("settles a surviving delivery after explicit discovered %s recovery without preparing or replaying files", async status => {
  const f = setup(); let ready = false;
  const receiver = new WritingAgentFileDelivery({ ...f, canApply: () => ready, isCurrentManuscript: () => true });
  receivers.push(receiver);
  f.proposals.latest.mockResolvedValue({ ...proposal, status: status === "rolledBack" ? "undone" : "applied" });
  receiver.register(admission);
  await vi.waitFor(() => expect(receiver.getSnapshot()[0]?.status).toBe("waiting"));
  const state = { kind: "state" as const, schemaVersion: 1 as const, scope: { manuscriptId: admission.scope.manuscriptId,
    conversationId: admission.scope.conversationId, proposalId: proposal.proposalId, operationId: crypto.randomUUID() }, status, files: [] };
  await receiver.recordRecoveredApplication(state, { kind: "state", state });
  expect(f.acknowledge).not.toHaveBeenCalled();
  ready = true; receiver.resume();
  await vi.waitFor(() => expect(receiver.getSnapshot()).toEqual([]));
  expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(admission);
  expect(f.accept).not.toHaveBeenCalled(); expect(f.prepareFiles).not.toHaveBeenCalled();
  expect(f.reviews.review).not.toHaveBeenCalled(); expect(f.proposals.publish).not.toHaveBeenCalled();
});
it("does not use an unconfirmed or mismatched discovered result as saved delivery proof", async () => {
  const f = setup(); let ready = false;
  const receiver = new WritingAgentFileDelivery({ ...f, canApply: () => ready, isCurrentManuscript: () => true });
  receivers.push(receiver); f.proposals.latest.mockResolvedValue(proposal); receiver.register(admission);
  await vi.waitFor(() => expect(receiver.getSnapshot()[0]?.status).toBe("waiting"));
  const state = { kind: "state" as const, schemaVersion: 1 as const, scope: { manuscriptId: admission.scope.manuscriptId,
    conversationId: admission.scope.conversationId, proposalId: proposal.proposalId, operationId: crypto.randomUUID() }, status: "applied" as const, files: [] };
  await receiver.recordRecoveredApplication(state, { kind: "unconfirmed", state });
  await receiver.recordRecoveredApplication(state, { kind: "state", state: { ...state, scope: { ...state.scope, operationId: crypto.randomUUID() } } });
  ready = true; receiver.resume();
  await vi.waitFor(() => expect(f.accept).toHaveBeenCalledOnce());
  expect(f.prepareFiles).toHaveBeenCalledOnce();
});
