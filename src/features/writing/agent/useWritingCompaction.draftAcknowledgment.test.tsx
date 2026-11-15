/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {agentWritingCompactionStartRequest, decodeAgentEvent, type AgentSubmissionPreview, type AgentStartResponse, type AgentWritingCompactionPrepareRequest,
  type AgentHistoryResponse, type AgentHistoryWaitRequest, type AgentHistoryWaitResponse} from "@research-assistant/core/agent";
import type {AgentWritingCompactionGateway} from "@research-assistant/data/agent";
import raw from "../../../../../../tests/fixtures/agent-compaction-completed-v1.json";
import {ConversationDraftStore, conversationDraftKey} from "../../../../../../apps/web/src/core/features/agent/conversationDraftStore";
import {localConversationDraftPersistence} from "../../../../../../apps/web/src/core/features/agent/conversationDraftPersistence";
import {writingDraftAcknowledgments, type WritingDraftAcknowledgmentPort} from "../../../../../../apps/web/src/core/features/agent/writingDraftAcknowledgment";
import {registerStoragePersistence} from "../../../../../../apps/web/src/core/runtime/storagePersistence";
import {createWritingCompactionReceiptStore} from "./writingCompactionReceipt";
import {isWritingManualCompactionRecovery} from "./writingManualCompactionRecovery";
import {resetWritingCompactionOwnersForTests} from "./writingCompactionController";
import {useWritingCompaction} from "./useWritingCompaction";
import {WritingRuntimeAdmissionScope, type WritingRuntimeAdmission} from "../persistence/writingRuntimeAdmission";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); resetWritingCompactionOwnersForTests(); vi.restoreAllMocks();});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function fixture() {
  const events = raw.map(decodeAgentEvent), first = events.find(event => event.payload.type === "turnStarted" && event.payload.taskKind === "compact")!;
  if (first.payload.type !== "turnStarted") throw new Error("missing compact source facts");
  const scope = {manuscriptId: "11111111-1111-4111-8111-111111111111", conversationId: first.conversationId}, requestId = first.requestId, turnId = first.payload.turnId, revision = first.seq - 1;
  const preview: AgentSubmissionPreview = {schemaVersion: 1, ...scope, requestId, turnId, contextSnapshotId: first.payload.contextSnapshotId,
    input: {text: "/compact", model: first.payload.model, reasoningEffort: null, context: [{sourceId: "file", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: JSON.stringify({manuscriptId: scope.manuscriptId}), text: "original"}]}};
  const request: AgentWritingCompactionPrepareRequest = {expectedRevision: revision, request: {conversationId: scope.conversationId, requestId, text: "/compact", context: {manuscriptId: scope.manuscriptId, files: [{relativePath: "main.tex", expectedDiskSha256: "hash"}]}}};
  const rows = new Map<string, string>(), storage: Storage = {get length() {return rows.size;}, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => {rows.set(key, value);}, removeItem: key => {rows.delete(key);}, clear: () => rows.clear()};
  const receipts = createWritingCompactionReceiptStore(storage), draftScope = {hostKind: "manuscript" as const, hostId: scope.manuscriptId, conversationId: scope.conversationId}, draftKey = conversationDraftKey(draftScope);
  const drafts = new ConversationDraftStore(localConversationDraftPersistence(storage)); drafts.update(draftKey, "/compact"); const token = drafts.captureAcknowledgmentToken(draftKey, "/compact")!;
  const admission: AgentStartResponse = {schemaVersion: 1, conversationId: scope.conversationId, requestId, turnId, alreadyStarted: false, outcome: null};
  let end = revision;
  const waiters: {request: AgentHistoryWaitRequest; reply: ReturnType<typeof deferred<AgentHistoryWaitResponse>>}[] = [];
  const gateway = {prepareWriting: vi.fn<AgentWritingCompactionGateway["prepareWriting"]>(async () => ({preview, expectedRevision: revision})),
    prepareWritingStatus: vi.fn<AgentWritingCompactionGateway["prepareWritingStatus"]>(async intent => ({schemaVersion: 1, intent, status: {type: "committed", result: {preview, expectedRevision: revision},
      proof: {schemaVersion: 1, operationId: requestId, conversationId: scope.conversationId, family: "agent.writing.submission.prepare", epoch: scope.manuscriptId, sqlFence: "0", replayed: true, result: null}}})),
    restoreWriting: vi.fn<AgentWritingCompactionGateway["restoreWriting"]>(), start: vi.fn<AgentWritingCompactionGateway["start"]>(async () => admission),
    startStatus: vi.fn<AgentWritingCompactionGateway["startStatus"]>(async intent => ({schemaVersion: 1, intent, status: {type: "prepared", preview}})),
    prepareWritingQueued: vi.fn(), readWritingQueued: vi.fn(), settleWritingQueued: vi.fn()};
  const history = {create: vi.fn(), open: vi.fn(async () => ({schemaVersion: 1 as const, conversationId: scope.conversationId, watermark: end})),
    readHistory: vi.fn(async ({afterSeq}: {afterSeq: number}): Promise<AgentHistoryResponse> => ({schemaVersion: 1, conversationId: scope.conversationId, afterSeq, watermark: end, nextAfterSeq: null, events: events.slice(afterSeq, end)})),
    waitForHistory: vi.fn((request: AgentHistoryWaitRequest) => {const reply = deferred<AgentHistoryWaitResponse>(); waiters.push({request, reply}); return reply.promise;})};
  const turns = {interrupt: vi.fn()}, identity = crypto.randomUUID();
  const options = (store = drafts) => ({scope: {...scope, identity}, receipts, gateway, history, turns, draftAcknowledgments: writingDraftAcknowledgments(store)});
  const advance = (next = events.length) => {end = next; for (const waiter of waiters.splice(0)) {
    if (waiter.request.afterSeq >= end) {waiters.push(waiter); continue;} waiter.reply.resolve({schemaVersion: 1, conversationId: scope.conversationId, afterSeq: waiter.request.afterSeq, watermark: end, events: events.slice(waiter.request.afterSeq, end)});
  }};
  const started = () => gateway.startStatus.mockImplementation(async intent => ({schemaVersion: 1, intent, status: {type: "started", result: {...admission, alreadyStarted: true, outcome: "completed"}}}));
  return {scope, request, preview, admission, token, drafts, draftKey, storage, rows, receipts, gateway, history, options, advance, started};
}
async function mount(f: ReturnType<typeof fixture>, store = f.drafts, draftAcknowledgments?: WritingDraftAcknowledgmentPort, admission?: WritingRuntimeAdmission) {
  const options = {...f.options(store), ...(draftAcknowledgments ? {draftAcknowledgments} : {})}, root = createRoot(document.createElement("div")); let current!: ReturnType<typeof useWritingCompaction>, active = true;
  function Harness() {current = useWritingCompaction(options); return null;}
  await act(async () => root.render(admission ? <WritingRuntimeAdmissionScope value={admission}><Harness/></WritingRuntimeAdmissionScope> : <Harness/>));
  const close = async () => {if (active) {active = false; await act(async () => root.unmount());}}; closes.push(close);
  return {get: () => current, close};
}
function persistence(f: ReturnType<typeof fixture>, flush: () => Promise<void>) {registerStoragePersistence(f.storage, {backend: "IndexedDB", pending: false, error: undefined, resetting: false,
  flush, retry: async () => {}, reset: async () => {}, close: () => {}, subscribe: () => () => {}});}
function frozen(f: ReturnType<typeof fixture>) {const value = f.receipts.read(f.scope); if (!value || !isWritingManualCompactionRecovery(value)) throw new Error("missing frozen manual receipt"); return value;}
it("saves token/full prepare before both reliable flushes and dispatches no native I/O on a failed draft flush", async () => {
  const f = fixture(), gate = deferred<void>(); let entered = false;
  persistence(f, async () => {entered = true; await gate.promise;}); const h = await mount(f);
  let work!: Promise<boolean>; await act(async () => {work = h.get().execute(f.request, vi.fn(), f.token);});
  expect(entered).toBe(true); expect(frozen(f).manual.draftAcknowledgment).toEqual(f.token); expect(f.gateway.prepareWriting).not.toHaveBeenCalled();
  await act(async () => {gate.resolve(); await Promise.resolve();});
  await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledOnce());
  expect(f.drafts.read(f.draftKey)).toBe(""); await act(async () => {f.advance(); await work;});
  const g = fixture(); persistence(g, async () => {throw new Error("draft not durable");}); const failed = await mount(g);
  await act(async () => {expect(await failed.get().execute(g.request, undefined, g.token)).toBe(false);});
  expect(g.gateway.prepareWriting).not.toHaveBeenCalled(); expect(g.gateway.start).not.toHaveBeenCalled(); expect(g.drafts.read(g.draftKey)).toBe("/compact");
});
it.each([false, true])("cold prepare recovery does not clear or start; only exact started proof consumes the original revision (retyped=%s)", async retyped => {
  const f = fixture(); f.gateway.prepareWriting.mockRejectedValueOnce(new Error("prepare ACK lost")); const h = await mount(f);
  await act(async () => {await h.get().execute(f.request, undefined, f.token);}); await h.close(); resetWritingCompactionOwnersForTests();
  const reopenedDrafts = new ConversationDraftStore(localConversationDraftPersistence(f.storage));
  if (retyped) {reopenedDrafts.update(f.draftKey, ""); reopenedDrafts.update(f.draftKey, "/compact");}
  const view = await mount(f, reopenedDrafts);
  expect(f.gateway.start).not.toHaveBeenCalled(); expect(reopenedDrafts.read(f.draftKey)).toBe("/compact"); expect(frozen(f).manual.draftAcknowledgment).toEqual(f.token);
  f.started(); await act(async () => view.get().checkPreparation());
  expect(reopenedDrafts.read(f.draftKey)).toBe(retyped ? "/compact" : ""); expect(f.receipts.read(f.scope)).toBeNull();
  expect(f.gateway.prepareWriting).toHaveBeenCalledOnce(); expect(f.gateway.start).not.toHaveBeenCalled();
});
it("retains actual start Unknown through a cold reopen, then reads original proof with no current model or source preparation", async () => {
  const f = fixture(), h = await mount(f); f.gateway.start.mockRejectedValueOnce(new Error("start ACK lost"));
  await act(async () => {expect(await h.get().execute(f.request, undefined, f.token)).toBe(false);});
  const original = frozen(f); expect(original.manual.start?.request).toEqual(agentWritingCompactionStartRequest({preview: f.preview, expectedRevision: f.request.expectedRevision}));
  await h.close(); resetWritingCompactionOwnersForTests(); f.started();
  f.gateway.prepareWriting.mockRejectedValue(new Error("current model disabled")); f.gateway.prepareWritingStatus.mockRejectedValue(new Error("source removed"));
  const drafts = new ConversationDraftStore(localConversationDraftPersistence(f.storage)), reopened = await mount(f, drafts);
  await vi.waitFor(() => expect(reopened.get().state?.phase).toBe("started"));
  expect(drafts.read(f.draftKey)).toBe(""); expect(f.gateway.start).toHaveBeenCalledOnce(); expect(f.gateway.prepareWriting).toHaveBeenCalledOnce();
  expect(f.gateway.prepareWritingStatus).not.toHaveBeenCalled(); expect(f.receipts.read(f.scope)).toBeNull();
});
it("persists knownStarted before draft consumption and retries a failed local acknowledgment without another native start or status read", async () => {
  const f = fixture(); let disabled = false;
  const h = await mount(f, f.drafts, undefined, {isDisabled: () => disabled, subscribe: () => () => undefined}); let fail = true;
  persistence(f, async () => {const row = f.receipts.read(f.scope); if (fail && row && isWritingManualCompactionRecovery(row) && row.manual.start?.result) throw new Error("known result not durable");});
  await act(async () => {void h.get().execute(f.request, undefined, f.token);});
  await vi.waitFor(() => expect(h.get().manualPreparation?.phase).toBe("localError"));
  expect(h.get().state?.phase).toBe("started"); expect(f.drafts.read(f.draftKey)).toBe("/compact"); expect(frozen(f).manual.start?.result).toMatchObject({turnId: f.preview.turnId});
  const checks = f.gateway.startStatus.mock.calls.length; fail = false; disabled = true; await act(async () => h.get().retry());
  expect(f.drafts.read(f.draftKey)).toBe(""); expect(f.gateway.start).toHaveBeenCalledOnce(); expect(f.gateway.startStatus).toHaveBeenCalledTimes(checks); expect(f.receipts.read(f.scope)).toBeNull();
});
it("a terminal arriving before the delayed start ACK cannot erase the token until original start status is proven", async () => {
  const f = fixture(), response = deferred<AgentStartResponse>(), h = await mount(f); f.gateway.start.mockReturnValueOnce(response.promise);
  f.gateway.startStatus.mockRejectedValue(new Error("readonly proof unavailable"));
  let work!: Promise<boolean>; await act(async () => {work = h.get().execute(f.request, undefined, f.token);});
  await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledOnce()); await act(async () => {f.advance(); await work;});
  expect(frozen(f).manual.draftAcknowledgment).toEqual(f.token); expect(f.drafts.read(f.draftKey)).toBe("/compact");
  await act(async () => {response.resolve(f.admission); await Promise.resolve();});
  await vi.waitFor(() => expect(f.receipts.read(f.scope)).toBeNull()); expect(f.drafts.read(f.draftKey)).toBe("");
});
it("blocks first start after its durable intent flush and discards through Prepared without consuming the draft", async () => {
  const f = fixture(); let disabled = false, flushing = false;
  const gate = deferred<void>();
  persistence(f, async () => {
    const saved = f.receipts.read(f.scope);
    if (saved && isWritingManualCompactionRecovery(saved) && saved.manual.start && !saved.manual.start.result) {flushing = true; await gate.promise;}
  });
  const h = await mount(f, f.drafts, undefined, {isDisabled: () => disabled, subscribe: () => () => undefined});
  let work!: Promise<boolean>; await act(async () => {work = h.get().execute(f.request, undefined, f.token);});
  await vi.waitFor(() => expect(flushing).toBe(true)); disabled = true;
  await act(async () => {gate.resolve(); expect(await work).toBe(false);});
  expect(f.gateway.start).not.toHaveBeenCalled(); expect(f.drafts.read(f.draftKey)).toBe("/compact");
  expect(h.get().manualPreparation?.priorStartUnknown).not.toBe(true);
  expect(h.get().manualAdmission).toMatchObject({startMayHaveDispatched: false, blockedBeforeDispatch: "start"});
  await act(async () => expect(await h.get().discardPreparation()).toBe(true));
  expect(f.gateway.startStatus).toHaveBeenCalled(); expect(f.receipts.read(f.scope)).toBeNull();
  expect(h.get().pending).toBe(false); expect(f.drafts.read(f.draftKey)).toBe("/compact");
});
it.each(["draft", "receipt"] as const)("does not turn a pre-dispatch %s flush failure into Unknown replay authority", async source => {
  const f = fixture(), cause = new Error("COMPACTION_RECOVERY_PERSISTENCE_FAILED"); let disabled = false, fail = true;
  const beforeStart = () => fail && !!frozen(f).manual.start && !frozen(f).manual.start?.result;
  const drafts = writingDraftAcknowledgments(f.drafts), draftFlush = drafts.flush;
  if (source === "draft") drafts.flush = async () => {if (beforeStart()) throw cause; await draftFlush();};
  else {
    const receiptFlush = f.receipts.flush!;
    vi.spyOn(f.receipts, "flush").mockImplementation(async () => {if (beforeStart()) throw cause; await receiptFlush();});
  }
  const h = await mount(f, f.drafts, drafts, {isDisabled: () => disabled, subscribe: () => () => undefined});
  await act(async () => expect(await h.get().execute(f.request, undefined, f.token)).toBe(false));
  const original = frozen(f).manual.start!.request;
  expect(h.get().state).toMatchObject({phase: "error", error: "startRejected", cause});
  expect(h.get().manualPreparation?.priorStartUnknown).not.toBe(true);
  expect(h.get().manualAdmission).toMatchObject({startMayHaveDispatched: false, blockedBeforeDispatch: "start"});
  expect(f.gateway.start).not.toHaveBeenCalled(); expect(f.drafts.read(f.draftKey)).toBe("/compact");
  disabled = true; fail = false;
  await act(async () => {expect(await h.get().retry()).toBe(false); expect(await h.get().checkPreparation()).toBe(false); expect(await h.get().retry()).toBe(false);});
  expect(f.gateway.startStatus).toHaveBeenCalled(); expect(f.gateway.start).not.toHaveBeenCalled();
  expect(h.get().manualPreparation?.priorStartUnknown).not.toBe(true);
  expect(frozen(f).manual.start?.request).toEqual(original); expect(f.drafts.read(f.draftKey)).toBe("/compact");
  disabled = false;
  let work!: Promise<boolean>; await act(async () => {work = h.get().retry();});
  await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledExactlyOnceWith(original));
  await act(async () => {f.advance(); expect(await work).toBe(true);});
  expect(f.gateway.prepareWriting).toHaveBeenCalledOnce(); expect(f.receipts.read(f.scope)).toBeNull();
});
it("preserves a true cold Unknown when its local retry flush fails, then replays only the original start while disabled", async () => {
  const f = fixture(), first = await mount(f); f.gateway.start.mockRejectedValueOnce(new Error("start ACK lost"));
  await act(async () => expect(await first.get().execute(f.request, undefined, f.token)).toBe(false));
  const original = frozen(f).manual.start!.request;
  await first.close(); resetWritingCompactionOwnersForTests();
  const drafts = writingDraftAcknowledgments(f.drafts), flush = drafts.flush; let fail = true;
  drafts.flush = async () => {if (fail) throw new Error("COMPACTION_RECOVERY_PERSISTENCE_FAILED"); await flush();};
  const cold = await mount(f, f.drafts, drafts, {isDisabled: () => true, subscribe: () => () => undefined});
  await vi.waitFor(() => expect(cold.get().state?.phase).toBe("preview"));
  await act(async () => expect(await cold.get().retry()).toBe(false));
  expect(cold.get().state?.error).toBe("start"); expect(cold.get().manualPreparation?.priorStartUnknown).toBe(true);
  expect(cold.get().manualAdmission).toMatchObject({startMayHaveDispatched: true, blockedBeforeDispatch: null});
  expect(f.gateway.start).toHaveBeenCalledOnce(); expect(await cold.get().discardPreparation()).toBe(false);
  fail = false;
  await act(async () => expect(await cold.get().retry()).toBe(false));
  expect(cold.get().manualPreparation?.phase).toBe("ready"); expect(f.gateway.start).toHaveBeenCalledOnce();
  let work!: Promise<boolean>; await act(async () => {work = cold.get().retry();});
  await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledTimes(2));
  expect(f.gateway.start.mock.calls).toEqual([[original], [original]]);
  await act(async () => {f.advance(); expect(await work).toBe(true);});
  expect(f.drafts.read(f.draftKey)).toBe(""); expect(f.receipts.read(f.scope)).toBeNull();
});
it("allows warm unstarted cleanup after an earlier Unknown prepare becomes committed", async () => {
  const f = fixture(); let disabled = false;
  const h = await mount(f, f.drafts, undefined, {isDisabled: () => disabled, subscribe: () => () => undefined});
  f.gateway.prepareWriting.mockRejectedValueOnce(new Error("lost prepare"));
  await act(async () => expect(await h.get().execute(f.request, undefined, f.token)).toBe(false)); disabled = true;
  await act(async () => expect(await h.get().retry()).toBe(false));
  expect(h.get().manualPreparation?.priorUnknown).toBe(true);
  expect(h.get().manualAdmission).toMatchObject({prepareMayHaveDispatched: true, startMayHaveDispatched: false, blockedBeforeDispatch: "start"});
  expect(f.gateway.prepareWriting).toHaveBeenCalledOnce(); expect(f.gateway.start).not.toHaveBeenCalled();
  await act(async () => expect(await h.get().discardPreparation()).toBe(true));
  expect(f.drafts.read(f.draftKey)).toBe("/compact"); expect(f.receipts.read(f.scope)).toBeNull();
});
it("legacy v3 without a token recovers and completes without acquiring authority over the current draft", async () => {
  const f = fixture(), receiptKey = `research-assistant:writing-compaction-receipt:v1:${f.scope.manuscriptId}:${f.scope.conversationId}`;
  f.rows.set(receiptKey, JSON.stringify({schemaVersion: 3, ...f.scope, requestId: f.request.request.requestId, manual: {prepare: f.request, result: {preview: f.preview, expectedRevision: f.request.expectedRevision}, knownRejected: false, rejection: null}}));
  const h = await mount(f); expect(f.gateway.startStatus).not.toHaveBeenCalled();
  let work!: Promise<boolean>; await act(async () => {work = h.get().retry();}); await act(async () => {f.advance(); await work;});
  expect(f.drafts.read(f.draftKey)).toBe("/compact"); expect(f.gateway.start).toHaveBeenCalledOnce(); expect(f.receipts.read(f.scope)).toBeNull();
});
it("a stale readonly failure cannot replace an already acknowledged start or restart its local cleanup", async () => {
  const f = fixture(), reply = deferred<AgentStartResponse>(), read = deferred<void>(), h = await mount(f);
  f.gateway.start.mockReturnValueOnce(reply.promise); f.gateway.startStatus.mockImplementation(async () => {await read.promise; throw new Error("late stale read");});
  let work!: Promise<boolean>; await act(async () => {work = h.get().execute(f.request, undefined, f.token);});
  await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledOnce()); await act(async () => {f.advance(); await work;});
  await act(async () => {reply.resolve(f.admission); await Promise.resolve();}); await vi.waitFor(() => expect(f.receipts.read(f.scope)).toBeNull());
  await act(async () => {read.resolve(); await Promise.resolve();});
  expect(h.get().state).toMatchObject({phase: "started", outcome: "completed"}); expect(h.get().manualPreparation?.cause).toBeNull();
  expect(f.drafts.read(f.draftKey)).toBe(""); expect(f.gateway.start).toHaveBeenCalledOnce();
});
it("a detached recovery callback and a late R1 ACK cannot consume or replace a newer R2 draft locator", async () => {
  const f = fixture(), reply = deferred<AgentStartResponse>(), h = await mount(f); f.gateway.start.mockReturnValueOnce(reply.promise);
  await act(async () => {void h.get().execute(f.request, undefined, f.token);}); await vi.waitFor(() => expect(f.gateway.start).toHaveBeenCalledOnce());
  const old = {check: h.get().checkPreparation, retry: h.get().retry, discard: h.get().discardPreparation};
  await h.close(); resetWritingCompactionOwnersForTests();
  f.drafts.update(f.draftKey, "newer draft"); const replacement = {...f.request, request: {...f.request.request, requestId: crypto.randomUUID()}};
  const locator = [...f.rows.keys()].find(key => key.includes("writing-compaction-receipt"))!;
  const newer = JSON.stringify({schemaVersion: 4, ...f.scope, requestId: replacement.request.requestId, manual: {prepare: replacement, result: null,
    knownRejected: false, rejection: null, draftAcknowledgment: f.drafts.captureAcknowledgmentToken(f.draftKey, "newer draft"), start: null}});
  f.rows.set(locator, newer); const checks = f.gateway.startStatus.mock.calls.length;
  await act(async () => {await old.check(); await old.retry(); await old.discard(); reply.resolve(f.admission); await Promise.resolve();});
  expect(f.rows.get(locator)).toBe(newer); expect(f.drafts.read(f.draftKey)).toBe("newer draft"); expect(f.gateway.start).toHaveBeenCalledOnce(); expect(f.gateway.startStatus).toHaveBeenCalledTimes(checks);
});
it("a completed draft CAS cannot delete a same-R locator replaced with a newer same-text draft token while its port is pending", async () => {
  const f = fixture(), gate = deferred<void>(), port = writingDraftAcknowledgments(f.drafts); let consumed = false;
  const prepared = {preview: f.preview, expectedRevision: f.request.expectedRevision};
  f.receipts.save({...f.scope, requestId: f.request.request.requestId, manual: {prepare: f.request, result: prepared,
    knownRejected: false, rejection: null, draftAcknowledgment: f.token,
    start: {request: agentWritingCompactionStartRequest(prepared), result: {...f.admission, alreadyStarted: true, outcome: "completed"}}}});
  const h = await mount(f, f.drafts, {...port, consume: async (token, scope) => {
    await port.consume(token, scope); consumed = true; await gate.promise;
  }});
  await vi.waitFor(() => expect(consumed).toBe(true)); expect(f.drafts.read(f.draftKey)).toBe("");
  f.drafts.update(f.draftKey, "/compact"); const replacement = f.drafts.captureAcknowledgmentToken(f.draftKey, "/compact")!;
  expect(replacement.revision).not.toBe(f.token.revision);
  const original = frozen(f), locator = [...f.rows.keys()].find(key => key.includes("writing-compaction-receipt"))!;
  const newer = JSON.stringify({schemaVersion: 4, ...original, manual: {...original.manual, draftAcknowledgment: replacement}});
  f.rows.set(locator, newer);
  await act(async () => {gate.resolve(); await Promise.resolve();});
  await vi.waitFor(() => expect(h.get().manualPreparation?.phase).toBe("localError"));
  expect(f.rows.get(locator)).toBe(newer); expect(f.drafts.read(f.draftKey)).toBe("/compact");
  await act(async () => h.get().retry());
  expect(f.rows.get(locator)).toBe(newer); expect(f.drafts.captureAcknowledgmentToken(f.draftKey, "/compact")).toEqual(replacement);
  expect(f.gateway.prepareWriting).not.toHaveBeenCalled(); expect(f.gateway.prepareWritingStatus).not.toHaveBeenCalled();
  expect(f.gateway.restoreWriting).not.toHaveBeenCalled(); expect(f.gateway.start).not.toHaveBeenCalled(); expect(f.gateway.startStatus).not.toHaveBeenCalled();
});
it("old mounted R1 controls cannot check or consume R2 after the same owner begins another request", async () => {
  const f = fixture(), h = await mount(f); f.gateway.prepareWriting.mockRejectedValueOnce(new Error("R1 prepare ACK lost"));
  await act(async () => {await h.get().execute(f.request, undefined, f.token);});
  const old = {check: h.get().checkPreparation, retry: h.get().retry, discard: h.get().discardPreparation};
  f.started(); await act(async () => h.get().checkPreparation()); expect(h.get().state?.outcome).toBe("completed");
  f.drafts.update(f.draftKey, "newer draft"); const second = {...f.request, request: {...f.request.request, requestId: crypto.randomUUID()}};
  f.gateway.prepareWriting.mockRejectedValueOnce(new Error("R2 prepare ACK lost"));
  await act(async () => {await h.get().execute(second, undefined, f.drafts.captureAcknowledgmentToken(f.draftKey, "newer draft"));});
  expect(frozen(f).requestId).toBe(second.request.requestId); const before = [...f.rows.entries()]; const checks = f.gateway.startStatus.mock.calls.length;
  await act(async () => {await old.check(); await old.retry(); await old.discard();});
  expect([...f.rows.entries()]).toEqual(before); expect(f.gateway.startStatus).toHaveBeenCalledTimes(checks); expect(f.gateway.start).not.toHaveBeenCalled();
});
