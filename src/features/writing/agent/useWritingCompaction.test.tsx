/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { decodeAgentEvent, type AgentCompactionStartRequest, type AgentHistoryResponse, type AgentHistoryWaitRequest,
  type AgentHistoryWaitResponse, type AgentInterruptResponse, type AgentSessionResponse,
  type AgentStartResponse, type AgentSubmissionPreview, type AgentWritingCompactionPrepareRequest,
  type AgentWritingReceipt } from "@research-assistant/core/agent";
import completed from "../../../../../../tests/fixtures/agent-compaction-completed-v1.json";
import canceled from "../../../../../../tests/fixtures/agent-compaction-post-canceled-v1.json";
import { useWritingCompaction } from "./useWritingCompaction";
import {WritingRuntimeAdmissionScope, type WritingRuntimeAdmission} from "../persistence/writingRuntimeAdmission";
import {WritingCompactionAdmissionClosed} from "./writingCompactionAdmission";
import { createWritingCompactionReceiptStore } from "./writingCompactionReceipt";
import { resetWritingCompactionOwnersForTests } from "./writingCompactionController";
import type {AgentWritingCompactionGateway} from "@research-assistant/data/agent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  resetWritingCompactionOwnersForTests();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(raw: readonly unknown[] = completed) {
  const events = raw.map(decodeAgentEvent);
  const first = events.find(event => event.payload.type === "turnStarted" && event.payload.taskKind === "compact");
  if (!first || first.payload.type !== "turnStarted") throw new Error("missing native compact facts");
  const conversationId = first.conversationId, requestId = first.requestId, turnId = first.payload.turnId;
  const manuscriptId = "11111111-1111-4111-8111-111111111111", revision = first.seq - 1;
  const preview: AgentSubmissionPreview = { schemaVersion: 1, conversationId, requestId, manuscriptId, turnId,
    contextSnapshotId: first.payload.contextSnapshotId,
      input: { text: "/compact", model: first.payload.model, reasoningEffort: null, context: [{sourceId: "file", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: JSON.stringify({manuscriptId}), text: "original"}] } };
  const request: AgentWritingCompactionPrepareRequest = { expectedRevision: revision,
    request: { conversationId, requestId, text: "/compact", context: { manuscriptId, files: [{relativePath: "main.tex", expectedDiskSha256: "hash"}] } } };
  const receipt: AgentWritingReceipt = { conversationId, requestId, manuscriptId };
  const admission: AgentStartResponse = { schemaVersion: 1, conversationId, requestId, turnId, alreadyStarted: false, outcome: null };
  let end = revision;
  const waiters: { request: AgentHistoryWaitRequest; reply: ReturnType<typeof deferred<AgentHistoryWaitResponse>> }[] = [];
  const gateway = {
    prepareWritingQueued: vi.fn(), readWritingQueued: vi.fn(), settleWritingQueued: vi.fn(),
    prepareWriting: vi.fn(async (_request: AgentWritingCompactionPrepareRequest) => ({ preview, expectedRevision: revision })),
    prepareWritingStatus: vi.fn<AgentWritingCompactionGateway["prepareWritingStatus"]>(async intent => ({schemaVersion: 1 as const, intent,
      status: {type: "committed" as const, result: {preview, expectedRevision: revision}, proof: {schemaVersion: 1 as const, operationId: requestId,
        conversationId, family: "agent.writing.submission.prepare" as const, epoch: manuscriptId, sqlFence: "0", replayed: true, result: null}}})),
    restoreWriting: vi.fn(async (_receipt: AgentWritingReceipt) => ({ preview, expectedRevision: revision })),
    start: vi.fn(async (_request: AgentCompactionStartRequest): Promise<AgentStartResponse> => admission),
    startStatus: vi.fn<AgentWritingCompactionGateway["startStatus"]>(),
  };
  const history = {
    create: vi.fn(),
    open: vi.fn(async (): Promise<AgentSessionResponse> => ({ schemaVersion: 1, conversationId, watermark: end })),
    readHistory: vi.fn(async ({ afterSeq }: { afterSeq: number }): Promise<AgentHistoryResponse> => ({
      schemaVersion: 1, conversationId, afterSeq, events: events.slice(afterSeq, end), watermark: end, nextAfterSeq: null,
    })),
    waitForHistory: vi.fn((request: AgentHistoryWaitRequest) => {
      const reply = deferred<AgentHistoryWaitResponse>(); waiters.push({ request, reply }); return reply.promise;
    }),
  };
  const turns = { interrupt: vi.fn(async (): Promise<AgentInterruptResponse> => ({
    schemaVersion: 1, conversationId, turnId, cancellationRequested: true,
  })) };
  const memory = new Map<string, string>();
  const receipts = createWritingCompactionReceiptStore({
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, value); },
    removeItem: key => { memory.delete(key); },
  });
  const options = { scope: { identity: crypto.randomUUID(), conversationId, manuscriptId }, gateway, history, turns, receipts };
  function advance(next: number): void {
    end = next;
    for (const waiter of waiters.splice(0)) {
      if (waiter.request.afterSeq >= end) { waiters.push(waiter); continue; }
      waiter.reply.resolve({ schemaVersion: 1, conversationId, afterSeq: waiter.request.afterSeq,
        watermark: end, events: events.slice(waiter.request.afterSeq, end) });
    }
  }
  return { events, preview, revision, request, receipt, admission, gateway, history, turns, receipts, options, advance };
}
async function mount(f: ReturnType<typeof fixture>, admission?: WritingRuntimeAdmission) {
  const root = createRoot(document.createElement("div"));
  let current!: ReturnType<typeof useWritingCompaction>, mounted = true;
  function Harness() { current = useWritingCompaction(f.options); return null; }
  await act(async () => root.render(admission ? <WritingRuntimeAdmissionScope value={admission}><Harness /></WritingRuntimeAdmissionScope> : <Harness />));
  const close = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  cleanups.push(close);
  return { get: () => current, close };
}
it("blocks new compaction calls from a stale render and rechecks admission after prepare", async () => {
  const f = fixture(); let disabled = true;
  const h = await mount(f, {isDisabled: () => disabled, subscribe: () => () => undefined});
  await act(async () => expect(await h.get().execute(f.request)).toBe(false));
  await act(async () => expect(await h.get().executeQueued({inputId: crypto.randomUUID(), expectedQueueRevision: 0,
    previousRequestId: null, expectedRevision: f.revision, submission: f.request.request})).toBe(false));
  expect(f.gateway.prepareWritingQueued).not.toHaveBeenCalled();
  expect(f.gateway.prepareWriting).not.toHaveBeenCalled(); expect(f.gateway.start).not.toHaveBeenCalled();
  disabled = false;
  const prepared = deferred<{preview: AgentSubmissionPreview; expectedRevision: number}>();
  f.gateway.prepareWriting.mockReturnValueOnce(prepared.promise);
  let work!: Promise<boolean>; await act(async () => {work = h.get().execute(f.request);});
  await vi.waitFor(() => expect(f.gateway.prepareWriting).toHaveBeenCalledOnce()); disabled = true;
  await act(async () => {prepared.resolve({preview: f.preview, expectedRevision: f.revision}); expect(await work).toBe(false);});
  expect(f.gateway.start).not.toHaveBeenCalled(); expect(h.get().state).toMatchObject({phase: "error", error: "startRejected"});
  expect(h.get().state?.cause).toBeInstanceOf(WritingCompactionAdmissionClosed);
  await act(async () => expect(await h.get().retry()).toBe(false)); expect(f.gateway.start).not.toHaveBeenCalled();
});
it("keeps an original uncertain start retry and its frozen identity available after disable", async () => {
  const f = fixture(); let disabled = false;
  const h = await mount(f, {isDisabled: () => disabled, subscribe: () => () => undefined});
  f.gateway.start.mockRejectedValueOnce(new Error("lost start ACK"));
  await act(async () => expect(await h.get().execute(f.request)).toBe(false));
  disabled = true;
  let work!: Promise<boolean>; await act(async () => {work = h.get().retry();});
  await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledTimes(2));
  expect(f.gateway.start.mock.calls[0]).toEqual(f.gateway.start.mock.calls[1]);
  await act(async () => {f.advance(f.events.length); expect(await work).toBe(true);});
  expect(f.gateway.prepareWriting).toHaveBeenCalledOnce();
});
it("blocks a new queued prepare after its original local reservation flush", async () => {
  const f = fixture(); let disabled = false;
  const flush = deferred<void>(); f.options.receipts = {...f.receipts, flush: () => flush.promise};
  const h = await mount(f, {isDisabled: () => disabled, subscribe: () => () => undefined});
  let work!: Promise<boolean>;
  await act(async () => {work = h.get().executeQueued({inputId: crypto.randomUUID(), expectedQueueRevision: 0,
    previousRequestId: null, expectedRevision: f.revision, submission: f.request.request});});
  expect(h.get().queuedRecovery).not.toBeNull(); disabled = true;
  await act(async () => {flush.resolve(); expect(await work).toBe(false);});
  expect(f.gateway.prepareWritingQueued).not.toHaveBeenCalled(); expect(f.gateway.start).not.toHaveBeenCalled();
  await act(async () => expect(await h.get().retry()).toBe(false));
  expect(f.gateway.prepareWritingQueued).not.toHaveBeenCalled(); expect(h.get().queuedPending).toBe(true);
});
it("settles an already dispatched start ACK and history after disable without losing acknowledgment", async () => {
  const f = fixture(); let disabled = false;
  const h = await mount(f, {isDisabled: () => disabled, subscribe: () => () => undefined});
  const reply = deferred<AgentStartResponse>(), acknowledge = vi.fn(); f.gateway.start.mockReturnValueOnce(reply.promise);
  let work!: Promise<boolean>; await act(async () => {work = h.get().execute(f.request, acknowledge);});
  await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledOnce()); disabled = true;
  await act(async () => {reply.resolve(f.admission); f.advance(f.events.length); expect(await work).toBe(true);});
  expect(acknowledge).toHaveBeenCalledOnce(); expect(f.gateway.start).toHaveBeenCalledOnce(); expect(f.receipts.read(f.receipt)).toBeNull();
});
it("uses original read-only preparation recovery while disabled without dispatching another prepare", async () => {
  const f = fixture(); let disabled = false;
  const h = await mount(f, {isDisabled: () => disabled, subscribe: () => () => undefined});
  f.gateway.prepareWriting.mockRejectedValueOnce(new Error("lost prepare ACK"));
  await act(async () => expect(await h.get().execute(f.request)).toBe(false)); disabled = true;
  await act(async () => expect(await h.get().retry()).toBe(false));
  expect(f.gateway.prepareWriting).toHaveBeenCalledOnce(); expect(f.gateway.prepareWritingStatus).toHaveBeenCalled();
  expect(f.gateway.start).not.toHaveBeenCalled(); expect(h.get().state).toMatchObject({phase: "error", error: "startRejected"});
  expect(h.get().state?.cause).toBeInstanceOf(WritingCompactionAdmissionClosed);
});

it("restores a lost prepare acknowledgement with the same receipt, then waits for explicit confirmation", async () => {
  const f = fixture(), h = await mount(f);
  f.gateway.prepareWriting.mockRejectedValueOnce(new Error("lost prepare acknowledgement"));
  await act(async () => { expect(await h.get().execute(f.request)).toBe(false); });
  expect(h.get().state).toMatchObject({ error: "prepare", request: f.request });
  expect(f.receipts.read(f.receipt)).toMatchObject({...f.receipt, manual: {prepare: {expectedRevision: f.revision, request: f.request.request}}});
  expect(f.gateway.start).not.toHaveBeenCalled();
  await h.close(); resetWritingCompactionOwnersForTests();
  const restored = await mount(f);
  expect(f.gateway.restoreWriting).not.toHaveBeenCalled(); expect(f.gateway.prepareWritingStatus).toHaveBeenCalledOnce();
  expect(restored.get().state).toMatchObject({ phase: "preview", preview: { expectedRevision: f.revision,
    contextSnapshotId: f.preview.contextSnapshotId, input: f.preview.input } });
  expect(restored.get().restored).toBe(true);
  expect(f.gateway.start).not.toHaveBeenCalled();
  expect(f.history.open).toHaveBeenCalledExactlyOnceWith(f.receipt.conversationId);
  expect(restored.get().dismiss()).toBe(false);
  let retry!: Promise<boolean>;
  await act(async () => { retry = restored.get().retry(); });
  expect(f.gateway.start).toHaveBeenCalledExactlyOnceWith({ conversationId: f.receipt.conversationId,
    requestId: f.receipt.requestId, expectedRevision: f.revision,
    contextSnapshotId: f.preview.contextSnapshotId, model: f.preview.input.model,
    host: { kind: "manuscript", manuscriptId: f.receipt.manuscriptId } });
  await act(async () => { f.advance(f.events.length); expect(await retry).toBe(true); });
  expect(f.gateway.prepareWriting).toHaveBeenCalledTimes(1);
  expect(f.receipts.read(f.receipt)).toBeNull();
});

it("retries an unknown start with the exact frozen request instead of preparing a second command", async () => {
  const f = fixture(), h = await mount(f), accepted = vi.fn();
  f.gateway.start.mockRejectedValueOnce({ code: "recoveryRequired" });
  await act(async () => { expect(await h.get().execute(f.request, accepted)).toBe(false); });
  expect(h.get().state).toMatchObject({ phase: "error", error: "start", outcome: null });
  expect(h.get().dismiss()).toBe(false);
  expect(accepted).not.toHaveBeenCalled();
  expect(f.receipts.read(f.receipt)).toMatchObject({...f.receipt, manual: {prepare: {expectedRevision: f.revision, request: f.request.request}}});
  f.gateway.start.mockResolvedValueOnce({ ...f.admission, alreadyStarted: true });
  let retry!: Promise<boolean>;
  await act(async () => { retry = h.get().retry(); });
  expect(f.gateway.start.mock.calls[1]).toEqual(f.gateway.start.mock.calls[0]);
  expect(f.gateway.prepareWriting).toHaveBeenCalledTimes(1);
  expect(f.gateway.restoreWriting).not.toHaveBeenCalled();
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(h.get().pending).toBe(true);
  await act(async () => { f.advance(f.events.length); expect(await retry).toBe(true); });
  expect(h.get().state?.outcome).toBe("completed");
  expect(f.turns.interrupt).not.toHaveBeenCalled();
});

it("keeps an installed compact pending after a stop acknowledgement until native history reports cancellation", async () => {
  const f = fixture(canceled), terminal = f.events.find(event => event.payload.type === "turnFinished"
    && event.payload.turnId === f.preview.turnId);
  if (!terminal) throw new Error("missing native terminal");
  f.advance(terminal.seq - 1);
  const h = await mount(f);
  let executing!: Promise<boolean>, settled = false;
  await act(async () => { executing = h.get().execute(f.request); void executing.then(() => { settled = true; }); });
  const turn = h.get().history?.projection?.turns.get(f.preview.turnId);
  expect([...turn?.items.values() ?? []].some(item => item.kind.type === "contextCompaction" && item.completed)).toBe(true);
  expect(h.get().state?.outcome).toBeNull();
  await act(async () => h.get().stop());
  expect(f.turns.interrupt).toHaveBeenCalledExactlyOnceWith({ conversationId: f.receipt.conversationId, turnId: f.preview.turnId });
  expect(h.get().state).toMatchObject({ outcome: null, stopRequested: true });
  expect(h.get().pending).toBe(true);
  expect(settled).toBe(false);
  expect(f.receipts.read(f.receipt)).toMatchObject({...f.receipt, manual: {prepare: {expectedRevision: f.revision, request: f.request.request}}});
  await act(async () => { f.advance(f.events.length); expect(await executing).toBe(false); });
  expect(h.get().state).toMatchObject({ outcome: "canceled", stopRequested: false });
  expect(f.receipts.read(f.receipt)).toBeNull();
});

it("retains the execution owner and history subscription when the view detaches", async () => {
  const f = fixture(), h = await mount(f), reply = deferred<AgentStartResponse>();
  f.gateway.start.mockReturnValueOnce(reply.promise);
  let executing!: Promise<boolean>;
  await act(async () => { executing = h.get().execute(f.request); });
  expect(h.get().state?.phase).toBe("starting");
  await h.close();
  expect(f.turns.interrupt).not.toHaveBeenCalled();
  const reopened = await mount(f);
  expect(reopened.get().state?.phase).toBe("starting");
  expect(f.gateway.prepareWriting).toHaveBeenCalledTimes(1);
  expect(f.gateway.restoreWriting).not.toHaveBeenCalled();
  await act(async () => { reply.resolve(f.admission); });
  expect(reopened.get().state?.phase).toBe("started");
  await act(async () => { f.advance(f.events.length); expect(await executing).toBe(true); });
  expect(reopened.get().state?.outcome).toBe("completed");
  expect(f.gateway.start).toHaveBeenCalledTimes(1);
  expect(f.turns.interrupt).not.toHaveBeenCalled();
});

it("accepts a durable terminal without waiting for a stalled start acknowledgement", async () => {
  const f = fixture(), h = await mount(f), reply = deferred<AgentStartResponse>();
  f.gateway.start.mockReturnValueOnce(reply.promise);
  let executing!: Promise<boolean>, settled: boolean | undefined;
  await act(async () => {
    executing = h.get().execute(f.request); void executing.then(value => { settled = value; });
  });
  expect(h.get().state?.phase).toBe("starting");
  await act(async () => { f.advance(f.events.length); });
  expect(h.get().state?.outcome).toBe("completed");
  expect(settled).toBe(true);
  expect(f.receipts.read(f.receipt)).toBeNull();
  await act(async () => { reply.resolve(f.admission); await executing; });
  expect(h.get().state?.outcome).toBe("completed");
  expect(f.gateway.start).toHaveBeenCalledTimes(1);
});

it("repeats the original prepare envelope only after native restore confirms it was not saved", async () => {
  const f = fixture(), h = await mount(f);
  f.gateway.prepareWriting.mockRejectedValueOnce(new Error("request did not reach native"));
  await act(async () => { expect(await h.get().execute(f.request)).toBe(false); });
  f.gateway.prepareWritingStatus.mockResolvedValueOnce({schemaVersion: 1, intent: f.request, status: {type: "notFound"}});
  let retry!: Promise<boolean>;
  await act(async () => { retry = h.get().retry(); });
  expect(f.gateway.restoreWriting).not.toHaveBeenCalled(); expect(f.gateway.prepareWritingStatus).toHaveBeenCalledOnce();
  expect(f.gateway.prepareWriting).toHaveBeenCalledTimes(2);
  expect(f.gateway.prepareWriting.mock.calls[1]).toEqual(f.gateway.prepareWriting.mock.calls[0]);
  expect(f.gateway.start).toHaveBeenCalledTimes(1);
  expect(f.gateway.start.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: f.revision, requestId: f.receipt.requestId });
  await act(async () => { f.advance(f.events.length); expect(await retry).toBe(true); });
});

it("reopens failed history on explicit same-request retry after an unknown start", async () => {
  const f = fixture(), h = await mount(f);
  f.gateway.start.mockRejectedValueOnce({ code: "recoveryRequired" });
  f.history.open.mockRejectedValueOnce({ code: "unavailable" });
  await act(async () => { expect(await h.get().execute(f.request)).toBe(false); });
  expect(h.get().history?.status).toBe("error");
  let retry!: Promise<boolean>;
  await act(async () => { retry = h.get().retry(); });
  expect(f.history.open).toHaveBeenCalledTimes(2);
  expect(f.gateway.start.mock.calls[1]).toEqual(f.gateway.start.mock.calls[0]);
  await act(async () => { f.advance(f.events.length); expect(await retry).toBe(true); });
  expect(h.get().state?.outcome).toBe("completed");
  expect(f.turns.interrupt).not.toHaveBeenCalled();
});

it("releases a restored locator only when native historyChanged proves the original request was not admitted", async () => {
  const f = fixture(); f.receipts.save(f.receipt);
  const h = await mount(f);
  f.gateway.start.mockRejectedValueOnce({ code: "historyChanged", reason: { expected: f.revision, actual: f.events.length } });
  await act(async () => { expect(await h.get().retry()).toBe(false); });
  expect(h.get().state).toMatchObject({ error: "startRejected", cause: { code: "historyChanged" } });
  expect(h.get().restored).toBe(true);
  await act(async () => { expect(h.get().dismiss()).toBe(true); });
  expect(f.receipts.read(f.receipt)).toBeNull();
  const requestId = crypto.randomUUID(), next = { ...f.request, request: { ...f.request.request, requestId } };
  f.gateway.prepareWriting.mockResolvedValueOnce({ preview: { ...f.preview, requestId, turnId: crypto.randomUUID() }, expectedRevision: f.revision });
  f.gateway.start.mockRejectedValueOnce({ code: "busy" });
  await act(async () => { expect(await h.get().execute(next)).toBe(false); });
  expect(f.gateway.prepareWriting).toHaveBeenCalledExactlyOnceWith({...next, request: {...next.request, userInput: [], resources: [], model: null, retrieval: null, sessionConfig: null, turnConfig: null,
    context: {...next.request.context, files: next.request.context.files.map(file => ({...file, buffer: null, selection: null}))}}});
  expect(f.receipts.read(f.receipt)?.requestId).toBe(requestId);
});

it("keeps a restored unknown request locked against dismissal", async () => {
  const f = fixture(); f.receipts.save(f.receipt);
  const h = await mount(f);
  f.gateway.start.mockRejectedValueOnce({ code: "recoveryRequired" });
  await act(async () => { expect(await h.get().retry()).toBe(false); });
  expect(h.get().state?.error).toBe("start");
  expect(h.get().restored).toBe(true);
  expect(h.get().dismiss()).toBe(false);
  expect(f.receipts.read(f.receipt)).toEqual(f.receipt);
});

it("acknowledges the exact submitted draft once when history finishes before a lost start reply", async () => {
  const f = fixture(), h = await mount(f), reply = deferred<AgentStartResponse>(), acknowledged = vi.fn();
  f.gateway.start.mockReturnValueOnce(reply.promise);
  let executing!: Promise<boolean>;
  await act(async () => { executing = h.get().execute(f.request, acknowledged); });
  expect(acknowledged).not.toHaveBeenCalled();
  await act(async () => { f.advance(f.events.length); expect(await executing).toBe(true); });
  expect(h.get().state?.outcome).toBe("completed");
  expect(acknowledged).toHaveBeenCalledTimes(1);
  expect(f.receipts.read(f.receipt)).toBeNull();
  await act(async () => { reply.resolve(f.admission); });
  expect(acknowledged).toHaveBeenCalledTimes(1);
});

it("does not leave an orphan locator when an unsaved queued command stops before source preparation", async () => {
  const f = fixture(), h = await mount(f);
  f.gateway.restoreWriting.mockRejectedValueOnce("notFound");
  await act(async () => { expect(await h.get().recoverExisting(f.receipt)).toBe("notFound"); });
  expect(f.gateway.prepareWriting).not.toHaveBeenCalled();
  expect(f.gateway.start).not.toHaveBeenCalled();
  expect(f.receipts.read(f.receipt)).toBeNull();
  // The host's subsequent source capture failed or detached, so execute was
  // never called. Removing that queue item must not lock another command's R.
  const requestId = crypto.randomUUID(), next = { ...f.request, request: { ...f.request.request, requestId } };
  f.gateway.prepareWriting.mockResolvedValueOnce({ preview: { ...f.preview, requestId, turnId: crypto.randomUUID() }, expectedRevision: f.revision });
  f.gateway.start.mockRejectedValueOnce({ code: "busy" });
  await act(async () => { expect(await h.get().execute(next)).toBe(false); });
  expect(f.gateway.prepareWriting).toHaveBeenCalledExactlyOnceWith({...next, request: {...next.request, userInput: [], resources: [], model: null, retrieval: null, sessionConfig: null, turnConfig: null,
    context: {...next.request.context, files: next.request.context.files.map(file => ({...file, buffer: null, selection: null}))}}});
  expect(f.gateway.start).toHaveBeenCalledTimes(1);
  expect(f.receipts.read(f.receipt)?.requestId).toBe(requestId);
});

it("clears a completed restored request using only its durable history", async () => {
  const f = fixture(); f.receipts.save(f.receipt); f.advance(f.events.length);
  const h = await mount(f);
  expect(h.get().state).toMatchObject({ phase: "started", admission: null, outcome: "completed" });
  expect(h.get().pending).toBe(false);
  expect(f.receipts.read(f.receipt)).toBeNull();
  expect(f.gateway.restoreWriting).toHaveBeenCalledExactlyOnceWith(f.receipt);
  expect(f.gateway.prepareWriting).not.toHaveBeenCalled();
  expect(f.gateway.start).not.toHaveBeenCalled();
  expect(f.turns.interrupt).not.toHaveBeenCalled();
});

it("restores a real active Compact turn as stoppable without dispatching start", async () => {
  const f = fixture(canceled), terminal = f.events.find(event => event.payload.type === "turnFinished"
    && event.payload.turnId === f.preview.turnId);
  if (!terminal) throw new Error("missing native terminal");
  f.receipts.save(f.receipt); f.advance(terminal.seq - 1);
  const h = await mount(f);
  expect(h.get().state).toMatchObject({ phase: "started", admission: null, outcome: null });
  expect(f.gateway.start).not.toHaveBeenCalled();
  expect(h.get().pending).toBe(true);
  await act(async () => h.get().stop());
  expect(f.turns.interrupt).toHaveBeenCalledExactlyOnceWith({ conversationId: f.receipt.conversationId, turnId: f.preview.turnId });
  expect(h.get().state).toMatchObject({ outcome: null, stopRequested: true });
  await act(async () => { f.advance(f.events.length); });
  expect(h.get().state?.outcome).toBe("canceled");
  expect(f.receipts.read(f.receipt)).toBeNull();
  expect(f.gateway.start).not.toHaveBeenCalled();
});

it("keeps a restored preparation without a durable turn in preview until explicitly confirmed", async () => {
  const f = fixture(); f.receipts.save(f.receipt);
  const h = await mount(f);
  expect(h.get().history?.status).toBe("ready");
  expect(h.get().history?.projection?.turns.has(f.preview.turnId)).toBe(false);
  expect(h.get().state).toMatchObject({ phase: "preview", admission: null, outcome: null });
  expect(f.gateway.start).not.toHaveBeenCalled();
  let confirming!: Promise<boolean>;
  await act(async () => { confirming = h.get().retry(); });
  expect(f.gateway.start).toHaveBeenCalledTimes(1);
  await act(async () => { f.advance(f.events.length); expect(await confirming).toBe(true); });
});

it("preserves a restored receipt after history failure and retries only the read before any start", async () => {
  const f = fixture(); f.receipts.save(f.receipt);
  f.history.open.mockRejectedValueOnce({ code: "unavailable" });
  const h = await mount(f);
  expect(h.get().history?.status).toBe("error");
  expect(h.get().state?.phase).toBe("preview");
  expect(f.receipts.read(f.receipt)).toEqual(f.receipt);
  expect(f.gateway.start).not.toHaveBeenCalled();
  f.advance(f.events.length);
  await act(async () => { await h.get().retry(); });
  expect(f.history.open).toHaveBeenCalledTimes(2);
  expect(h.get().state).toMatchObject({ phase: "started", admission: null, outcome: "completed" });
  expect(f.receipts.read(f.receipt)).toBeNull();
  expect(f.gateway.start).not.toHaveBeenCalled();
});
