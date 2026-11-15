import { afterEach, expect, it, vi } from "vitest";
import { applyAgentEvents, createAgentConversationProjection, decodeAgentEvent, type AgentHistoryResponse, type AgentHistoryWaitResponse, type AgentSessionResponse,
  type AgentSubmissionPreview, type AgentStartResponse, type AgentWritingCompactionPrepareRequest } from "@research-assistant/core/agent";
import raw from "../../../../../../tests/fixtures/agent-compaction-completed-v1.json";
import { acquireWritingCompactionOwner, hasPendingWritingCompactions, resetWritingCompactionOwnersForTests, waitForWritingCompaction } from "./writingCompactionController";
import {createWritingCompactionReceiptStore} from "./writingCompactionReceipt";
import type {AgentWritingQueuedCompactionPreview} from "@research-assistant/core/agent";
import {agentWritingCompactionStartRequest, decodeAgentWritingQueuedCompactionPrepareRequest} from "@research-assistant/core/agent";
import {persistQueuedCompaction, queuedCompactionRecovery, queuedCompactionRequest, settleQueuedCompaction} from "./writingQueuedCompactionActions";
import {WritingCompactionAdmissionClosed} from "./writingCompactionAdmission";

const events = raw.map(decodeAgentEvent);
const first = events.find(event => event.payload.type === "turnStarted" && event.payload.taskKind === "compact");
if (!first || first.payload.type !== "turnStarted") throw new Error("missing native compact fixture");
const conversationId = first.conversationId, requestId = first.requestId, turnId = first.payload.turnId;
const manuscriptId = "11111111-1111-4111-8111-111111111111";
const preview: AgentSubmissionPreview = { schemaVersion: 1, conversationId, requestId, manuscriptId, turnId,
  contextSnapshotId: first.payload.contextSnapshotId,
  input: { text: "/compact", model: first.payload.model, reasoningEffort: null, context: [{sourceId: "file", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: JSON.stringify({manuscriptId}), text: "original"}] } };
const revision = first.seq - 1;
const request: AgentWritingCompactionPrepareRequest = { expectedRevision: revision,
  request: { conversationId, requestId, text: "/compact", context: { manuscriptId, files: [] } } };
const admission: AgentStartResponse = { schemaVersion: 1, conversationId, requestId, turnId, alreadyStarted: false, outcome: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup(end: number) {
  const entered = deferred<void>();
  const gateway = { prepareWritingQueued: vi.fn(), readWritingQueued: vi.fn(), settleWritingQueued: vi.fn(), prepareWriting: vi.fn(async () => ({ preview, expectedRevision: revision })), prepareWritingStatus: vi.fn(),
    restoreWriting: vi.fn(async () => ({ preview, expectedRevision: revision })), start: vi.fn(async () => admission), startStatus: vi.fn() };
  const history = {
    create: vi.fn(), open: vi.fn(async (): Promise<AgentSessionResponse> => ({ schemaVersion: 1, conversationId, watermark: end })),
    readHistory: vi.fn(async ({ afterSeq }: { afterSeq: number }): Promise<AgentHistoryResponse> => {
      entered.resolve();
      return { schemaVersion: 1, conversationId, afterSeq, events: events.slice(afterSeq, end), watermark: end, nextAfterSeq: null };
    }),
    waitForHistory: vi.fn(() => new Promise<AgentHistoryWaitResponse>(() => undefined)),
  };
  const turns = { interrupt: vi.fn() };
  const rows = new Map<string, string>(), receipts = createWritingCompactionReceiptStore({getItem: key => rows.get(key) ?? null, setItem: (key, value) => {rows.set(key, value);}, removeItem: key => {rows.delete(key);}});
  return { ports: { gateway, history, turns, receipts }, scope: { identity: "native-capture-test", conversationId, manuscriptId }, entered };
}
afterEach(resetWritingCompactionOwnersForTests);
it("retains the first owner's captured admission getter across another lease", async () => {
  const f = setup(revision); let disabled = true;
  const first = acquireWritingCompactionOwner(f.scope, {...f.ports, isAdmissionDisabled: () => disabled});
  const later = acquireWritingCompactionOwner(f.scope, {...f.ports, isAdmissionDisabled: () => false});
  expect(first.controller).toBe(later.controller);
  await later.controller.prepare(request);
  expect(f.ports.gateway.prepareWriting).not.toHaveBeenCalled();
  expect(later.controller.getSnapshot().cause).toBeInstanceOf(WritingCompactionAdmissionClosed);
  expect(later.controller.getManualAdmission().prepareMayHaveDispatched).toBe(false);
  disabled = false; first.release(); later.release();
});

function queuedFixture() {
  const f = setup(revision), inputId = crypto.randomUUID(); let disabled = false;
  const held = acquireWritingCompactionOwner({...f.scope, identity: crypto.randomUUID()}, {...f.ports, isAdmissionDisabled: () => disabled});
  const queued = decodeAgentWritingQueuedCompactionPrepareRequest({inputId, expectedQueueRevision: 0, previousRequestId: null,
    expectedRevision: revision, submission: {...request.request, model: {providerId: preview.input.model.providerId, modelId: preview.input.model.modelId}}});
  const claim: AgentWritingQueuedCompactionPreview = {schemaVersion: 1, kind: "compact", inputId, requestId, claimRevision: 1,
    expectedRevision: revision, preview, outcome: null, current: true,
    queue: {schemaVersion: 1, conversationId, manuscriptId, revision: 1, paused: false, preparingInputId: inputId, inputs: [{inputId, text: "/compact"}]}};
  return {...f, held, queued, claim, disable: () => {disabled = true;}, enable: () => {disabled = false;}};
}
it("discards only a warm queued prepare blocked before RPC after an exact NotFound and reliable removal", async () => {
  const f = queuedFixture(), controller = f.held.controller, recovery = queuedCompactionRecovery(f.queued);
  expect(await persistQueuedCompaction(controller, f.ports.receipts, recovery)).toBe(true);
  f.disable(); await controller.prepare(queuedCompactionRequest(f.queued));
  expect(f.ports.gateway.prepareWritingQueued).not.toHaveBeenCalled();
  expect(controller.getQueuedAdmission()).toMatchObject({prepareMayHaveDispatched: false, blockedBeforeDispatch: "prepare"});
  f.ports.gateway.readWritingQueued.mockResolvedValue(null);
  const flush = vi.fn().mockRejectedValueOnce(new Error("flush failed")).mockResolvedValue(undefined);
  const store = {...f.ports.receipts, flush};
  expect(await controller.discardQueuedAdmissionBlock(store)).toBe(false);
  expect(controller.queuedPending()).toBe(true); expect(f.ports.receipts.read(recovery)).toBeNull();
  expect(await controller.discardQueuedAdmissionBlock(store)).toBe(true);
  expect(controller.queuedPending()).toBe(false); expect(controller.getSnapshot().phase).toBe("idle");
  expect(flush).toHaveBeenCalledTimes(2); expect(f.ports.gateway.start).not.toHaveBeenCalled(); f.held.release();
});
it("preserves a committed queued claim when fresh start is blocked and later settles the exact original after admission", async () => {
  const f = queuedFixture(), controller = f.held.controller, recovery = queuedCompactionRecovery(f.queued);
  await persistQueuedCompaction(controller, f.ports.receipts, recovery);
  f.ports.gateway.prepareWritingQueued.mockImplementation(async () => {f.disable(); return f.claim;});
  await controller.prepare(queuedCompactionRequest(f.queued));
  await controller.confirm("chatGptDefault");
  expect(controller.getSnapshot()).toMatchObject({phase: "error", error: "startRejected"});
  expect(controller.getSnapshot().cause).toBeInstanceOf(WritingCompactionAdmissionClosed);
  expect(controller.getQueuedAdmission()).toMatchObject({prepareMayHaveDispatched: true, startMayHaveDispatched: false, blockedBeforeDispatch: "start"});
  expect(f.ports.gateway.start).not.toHaveBeenCalled(); expect(await controller.discardQueuedAdmissionBlock(f.ports.receipts)).toBe(false);
  expect(f.ports.receipts.read(recovery)).toEqual(recovery);
  f.enable(); expect(controller.dismiss()).toBe(true); f.ports.gateway.readWritingQueued.mockResolvedValue(f.claim);
  await controller.recover(recovery); await controller.confirm("chatGptDefault");
  expect(f.ports.gateway.start).toHaveBeenCalledExactlyOnceWith(agentWritingCompactionStartRequest({preview: f.claim.preview, expectedRevision: f.claim.expectedRevision}));
  f.disable(); controller.observeOutcome(turnId, "completed");
  f.ports.gateway.settleWritingQueued.mockResolvedValue({schemaVersion: 1, inputId: f.claim.inputId, requestId,
    outcome: "completed", queue: {...f.claim.queue, revision: 2, preparingInputId: null, inputs: []}});
  expect(await settleQueuedCompaction(controller, f.ports.receipts, {read: async () => f.claim.queue}, f.scope)).toBe(true);
  expect(f.ports.gateway.settleWritingQueued).toHaveBeenCalledOnce(); expect(f.ports.receipts.read(recovery)).toBeNull(); f.held.release();
});
it("does not give a cold queued locator fresh unsent cleanup authority", async () => {
  const f = queuedFixture(), recovery = queuedCompactionRecovery(f.queued);
  f.ports.receipts.save(recovery); f.held.controller.setQueuedRecovery(recovery, true); f.disable();
  f.ports.gateway.readWritingQueued.mockResolvedValue(null); await f.held.controller.recover(recovery);
  expect(f.held.controller.getQueuedAdmission()).toMatchObject({prepareMayHaveDispatched: true, startMayHaveDispatched: true, blockedBeforeDispatch: null});
  expect(await f.held.controller.discardQueuedAdmissionBlock(f.ports.receipts)).toBe(false);
  expect(f.ports.receipts.read(recovery)).toEqual(recovery); expect(f.ports.gateway.prepareWritingQueued).not.toHaveBeenCalled(); f.held.release();
});
it("reads the exact cold queued claim with null outcome without fabricating a start or settlement", async () => {
  const f = queuedFixture(), recovery = queuedCompactionRecovery(f.queued), controller = f.held.controller;
  f.ports.receipts.save(recovery); controller.setQueuedRecovery(recovery, true); f.disable();
  f.ports.gateway.readWritingQueued.mockResolvedValue(f.claim);
  await controller.recover(recovery);
  expect(f.ports.gateway.readWritingQueued).toHaveBeenCalledWith({conversationId, manuscriptId, requestId, inputId: f.queued.inputId});
  expect(controller.getQueuedAdmission()).toMatchObject({startMayHaveDispatched: true, blockedBeforeDispatch: null});
  expect(controller.getSnapshot().outcome).toBeNull(); expect(controller.queuedPending()).toBe(true);
  expect(await controller.discardQueuedAdmissionBlock(f.ports.receipts)).toBe(false);
  expect(f.ports.receipts.read(recovery)).toEqual(recovery);
  expect(f.ports.gateway.start).not.toHaveBeenCalled(); expect(f.ports.gateway.settleWritingQueued).not.toHaveBeenCalled(); f.held.release();
});
it.each([false, true])("replays only the exact original queued Unknown preparation while disabled (known rejection=%s)", async known => {
  const f = queuedFixture(), recovery = queuedCompactionRecovery(f.queued), controller = f.held.controller;
  await persistQueuedCompaction(controller, f.ports.receipts, recovery);
  f.ports.gateway.prepareWritingQueued.mockRejectedValueOnce(known ? {code: "modelUnavailable"} : new Error("lost prepare ACK"))
    .mockResolvedValue(f.claim);
  await controller.prepare(queuedCompactionRequest(f.queued)); f.disable();
  await controller.retryPrepare(false);
  expect(f.ports.gateway.prepareWritingQueued).toHaveBeenCalledTimes(known ? 1 : 2);
  if (!known) expect(f.ports.gateway.prepareWritingQueued.mock.calls[0]).toEqual(f.ports.gateway.prepareWritingQueued.mock.calls[1]);
  expect(f.ports.gateway.start).not.toHaveBeenCalled(); f.held.release();
});

it("does not use a cached compact outcome until the history snapshot is synchronized", async () => {
  const { ports, scope } = setup(events.length);
  const pending = deferred<AgentHistoryResponse>(), entered = deferred<void>();
  ports.history.readHistory.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
  const projection = applyAgentEvents(createAgentConversationProjection(conversationId), events);
  const lease = acquireWritingCompactionOwner(scope, { ...ports, projection });
  try {
    await lease.controller.recover({ conversationId, requestId, manuscriptId });
    await entered.promise;
    expect(lease.controller.history.getSnapshot()).toMatchObject({ status: "syncing", projection: { seq: events.length } });
    expect(lease.controller.getSnapshot()).toMatchObject({ phase: "preview", outcome: null });
    pending.resolve({ schemaVersion: 1, conversationId, afterSeq: events.length, events: [], watermark: events.length, nextAfterSeq: null });
    expect(await waitForWritingCompaction(lease.controller)).toBe(true);
    expect(lease.controller.getSnapshot().outcome).toBe("completed");
  } finally { lease.release(); }
});

it("keeps the owner through detachment and observes an early real terminal before the start reply", async () => {
  const { ports, scope, entered } = setup(events.length);
  const reply = deferred<AgentStartResponse>(); ports.gateway.start.mockReturnValueOnce(reply.promise);
  const view = acquireWritingCompactionOwner(scope, ports);
  const retained = acquireWritingCompactionOwner(scope, ports);
  expect(retained.controller).toBe(view.controller);
  await view.controller.prepare(request);
  const starting = view.controller.confirm("chatGptDefault");
  const finished = waitForWritingCompaction(retained.controller);
  view.release(); await entered.promise;
  expect(await finished).toBe(true);
  expect(retained.controller.getSnapshot().outcome).toBe("completed");
  reply.resolve(admission); await starting;
  expect(ports.gateway.start).toHaveBeenCalledExactlyOnceWith({ conversationId, requestId,
    contextSnapshotId: preview.contextSnapshotId, model: preview.input.model, expectedRevision: revision,
    host: { kind: "manuscript", manuscriptId } });
  expect(retained.controller.getSnapshot().phase).toBe("started");
  expect(ports.turns.interrupt).not.toHaveBeenCalled(); retained.release();
});

it("retains the same prepared request after an unknown start when the view returns", async () => {
  const { ports, scope } = setup(revision);
  ports.gateway.start.mockRejectedValueOnce(new Error("reply lost"));
  const view = acquireWritingCompactionOwner(scope, ports);
  const input = structuredClone(request);
  await view.controller.prepare(input); Object.assign(input, { expectedRevision: input.expectedRevision + 10 });
  await view.controller.confirm("chatGptDefault");
  view.release();
  const reopened = acquireWritingCompactionOwner(scope, ports);
  expect(reopened.controller.getSnapshot()).toMatchObject({ error: "start", request });
  expect(reopened.controller.dismiss()).toBe(false);
  ports.gateway.start.mockResolvedValueOnce({ ...admission, alreadyStarted: true, outcome: "completed" });
  await reopened.controller.confirm("chatGptDefault");
  expect(await waitForWritingCompaction(reopened.controller)).toBe(true);
  expect(ports.gateway.start.mock.calls[0]).toEqual(ports.gateway.start.mock.calls[1]);
  expect(ports.gateway.prepareWriting).toHaveBeenCalledTimes(1);
  expect(ports.turns.interrupt).not.toHaveBeenCalled(); reopened.release();
});
it.each([false, true])("only an actual Unknown start can replay the same intent while disabled (known rejection=%s)", async known => {
  const {ports, scope} = setup(revision); let disabled = false;
  ports.gateway.start.mockRejectedValueOnce(known ? {code: "modelUnavailable"} : new Error("start ACK lost"));
  const held = acquireWritingCompactionOwner(scope, {...ports, isAdmissionDisabled: () => disabled}), controller = held.controller;
  await controller.prepare(request); await controller.confirm("chatGptDefault");
  expect(controller.getSnapshot().error).toBe(known ? "startRejected" : "start");
  if (known) {expect(controller.dismiss()).toBe(true); await controller.recover({conversationId, manuscriptId, requestId});}
  disabled = true;
  await controller.confirm("chatGptDefault");
  if (known) {
    expect(controller.getSnapshot().error).toBe("startRejected");
    expect(controller.getSnapshot().cause).toBeInstanceOf(WritingCompactionAdmissionClosed);
    expect(controller.getManualAdmission()).toMatchObject({startMayHaveDispatched: true, blockedBeforeDispatch: null});
    expect(controller.getManualPreparation().priorStartUnknown).not.toBe(true);
    expect(controller.dismiss()).toBe(true); await controller.recover({conversationId, manuscriptId, requestId});
    await controller.confirm("chatGptDefault"); expect(controller.getSnapshot().error).toBe("startRejected");
    expect(ports.gateway.start).toHaveBeenCalledOnce();
  } else {
    expect(ports.gateway.start).toHaveBeenCalledTimes(2);
    expect(ports.gateway.start.mock.calls[0]).toEqual(ports.gateway.start.mock.calls[1]);
  }
  held.release();
});

it("restores native frozen input and history boundary without implicitly starting a task", async () => {
  const { ports, scope } = setup(revision);
  const lease = acquireWritingCompactionOwner(scope, ports);
  await lease.controller.recover({ conversationId, requestId, manuscriptId });
  expect(lease.controller.getSnapshot()).toMatchObject({ phase: "preview", preview: { expectedRevision: revision,
    contextSnapshotId: preview.contextSnapshotId, input: preview.input } });
  expect(ports.gateway.restoreWriting).toHaveBeenCalledWith({ conversationId, requestId, manuscriptId });
  expect(ports.gateway.prepareWriting).not.toHaveBeenCalled();
  expect(ports.gateway.start).not.toHaveBeenCalled();
  expect(ports.history.open).toHaveBeenCalledExactlyOnceWith(conversationId); lease.release();
});

it("does not treat a matching regular turn as restored Compact admission", async () => {
  const { ports, scope } = setup(first.seq);
  const history = events.slice(0, first.seq).map(event => event.payload.type === "turnStarted" && event.payload.turnId === turnId
    ? decodeAgentEvent({ ...event, payload: { ...event.payload, taskKind: "regular" } }) : event);
  ports.history.readHistory.mockResolvedValueOnce({ schemaVersion: 1, conversationId, afterSeq: 0,
    events: history, watermark: first.seq, nextAfterSeq: null });
  const lease = acquireWritingCompactionOwner(scope, ports);
  await lease.controller.recover({ conversationId, requestId, manuscriptId });
  // The feed must finish publishing its real projection before checking that
  // the adapter declined the wrong task kind rather than simply not reading.
  await vi.waitFor(() => expect(lease.controller.history.getSnapshot().projection?.seq).toBe(first.seq));
  expect(lease.controller.getSnapshot()).toMatchObject({ phase: "preview", admission: null, outcome: null });
  expect(ports.gateway.start).not.toHaveBeenCalled();
  lease.release();
});

it("keeps a hidden manual preparation pending until the original terminal and receipt cleanup", async () => {
  const {ports, scope} = setup(events.length);
  expect(hasPendingWritingCompactions()).toBe(false);
  const view = acquireWritingCompactionOwner(scope, ports);
  expect(hasPendingWritingCompactions()).toBe(false);
  await view.controller.prepare(request); view.release();
  const snapshot = view.controller.getSnapshot();
  expect(hasPendingWritingCompactions()).toBe(true);
  expect(hasPendingWritingCompactions()).toBe(true);
  expect(view.controller.getSnapshot()).toBe(snapshot);
  expect(ports.gateway.prepareWriting).toHaveBeenCalledOnce();
  expect(ports.gateway.start).not.toHaveBeenCalled(); expect(ports.history.open).not.toHaveBeenCalled();
  const reopened = acquireWritingCompactionOwner(scope, ports);
  expect(reopened.controller).toBe(view.controller);
  await reopened.controller.confirm("chatGptDefault");
  expect(await waitForWritingCompaction(reopened.controller)).toBe(true);
  expect(reopened.controller.getSnapshot().outcome).toBe("completed");
  expect(reopened.controller.manualPending()).toBe(true);
  expect(hasPendingWritingCompactions()).toBe(true);
  expect(await reopened.controller.clearManualPreparation()).toBe(true);
  expect(hasPendingWritingCompactions()).toBe(false);
  expect(ports.gateway.start).toHaveBeenCalledOnce(); expect(ports.turns.interrupt).not.toHaveBeenCalled();
  reopened.release();
});

it("retains a hidden idle queue recovery until its original settlement", () => {
  const {ports, scope} = setup(revision), view = acquireWritingCompactionOwner(scope, ports);
  const dispose = vi.spyOn(view.controller, "dispose");
  expect(hasPendingWritingCompactions()).toBe(false);
  view.controller.setQueuedRecovery({conversationId, requestId, manuscriptId, inputId: turnId, queued: {prepare: null, settle: null}});
  expect(view.controller.getSnapshot().phase).toBe("idle");
  view.release();
  const snapshot = view.controller.getSnapshot(), settlement = view.controller.getSettlement();
  expect(hasPendingWritingCompactions()).toBe(true);
  expect(view.controller.getSnapshot()).toBe(snapshot); expect(view.controller.getSettlement()).toBe(settlement);
  expect(dispose).not.toHaveBeenCalled();
  expect(ports.gateway.prepareWritingQueued).not.toHaveBeenCalled(); expect(ports.gateway.settleWritingQueued).not.toHaveBeenCalled();
  expect(ports.history.open).not.toHaveBeenCalled();
  view.controller.queuedSettled();
  expect(hasPendingWritingCompactions()).toBe(false);
  expect(dispose).toHaveBeenCalledOnce();
});
