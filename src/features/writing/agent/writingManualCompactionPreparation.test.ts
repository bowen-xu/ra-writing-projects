import {expect, it, vi} from "vitest";
import {decodeAgentWritingCompactionPrepareRequest, type AgentWritingCompactionPreview} from "@research-assistant/core/agent";
import type {AgentWritingCompactionGateway} from "@research-assistant/data/agent";
import {registerStoragePersistence} from "../../../../../../apps/web/src/core/runtime/storagePersistence";
import {WritingManualCompactionPreparation} from "./writingManualCompactionPreparation";
import {createWritingCompactionReceiptStore} from "./writingCompactionReceipt";
import {WritingCompactionAdmissionClosed} from "./writingCompactionAdmission";
const c = "11111111-1111-4111-8111-111111111111", m = "22222222-2222-4222-8222-222222222222", r = "33333333-3333-4333-8333-333333333333", t = "44444444-4444-4444-8444-444444444444";
const scope = {conversationId: c, manuscriptId: m, requestId: r};
const request = decodeAgentWritingCompactionPrepareRequest({expectedRevision: 17, request: {conversationId: c, requestId: r, text: "/compact", context: {manuscriptId: m,
  files: [{relativePath: "main.tex", expectedDiskSha256: "a".repeat(64), buffer: {revision: t, text: "original unsaved context"}}]}, model: {providerId: "fixture", modelId: "original"}}});
const result: AgentWritingCompactionPreview = {expectedRevision: 17, preview: {schemaVersion: 1, ...scope, turnId: t, contextSnapshotId: t,
  input: {text: "/compact", reasoningEffort: null, model: {providerId: "fixture", modelId: "original", revision: null},
    context: [{sourceId: "file", kind: "manuscript", resourceId: "main.tex", revision: t, anchor: JSON.stringify({manuscriptId: m}), text: "original unsaved context"}]}}};
function fixture() {
  const rows = new Map<string, string>(), storage: Storage = {get length() {return rows.size;}, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => {rows.set(key, value);}, removeItem: key => {rows.delete(key);}, clear: () => rows.clear()};
  const store = createWritingCompactionReceiptStore(storage);
  const prepare = vi.fn<AgentWritingCompactionGateway["prepareWriting"]>().mockRejectedValue("AGENT_PREVIEW_SYNTHETIC_IO_ACK_LOST");
  const status = vi.fn<AgentWritingCompactionGateway["prepareWritingStatus"]>().mockImplementation(async intent => ({schemaVersion: 1, intent, status: {type: "notFound"}}));
  const gateway: AgentWritingCompactionGateway = {prepareWriting: prepare, prepareWritingStatus: status, restoreWriting: vi.fn(), start: vi.fn(), startStatus: vi.fn(), prepareWritingQueued: vi.fn(), readWritingQueued: vi.fn(), settleWritingQueued: vi.fn()};
  const open = (isDisabled: () => boolean = () => false, changed: () => void = () => {}) => {
    const owner = new WritingManualCompactionPreparation(gateway, changed, isDisabled); owner.configure(store); return owner;
  };
  return {rows, storage, store, prepare, status, gateway, open};
}
function persistence(storage: Storage, flush: () => Promise<void>) {registerStoragePersistence(storage, {backend: "IndexedDB", pending: false, error: undefined, resetting: false,
  flush, retry: async () => {}, reset: async () => {}, subscribe: () => () => {}, close: () => {}});}
it("flushes the complete manual request and original watermark before first I/O, freezing caller mutation", async () => {
  const f = fixture(), owner = f.open(), caller = structuredClone(request); let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;}); persistence(f.storage, async () => {if (f.prepare.mock.calls.length === 0) await gate;});
  const work = owner.prepare(caller); await vi.waitFor(() => expect(f.rows.size).toBe(1)); expect(f.prepare).not.toHaveBeenCalled();
  (caller as {expectedRevision: number}).expectedRevision = 99; expect(JSON.parse([...f.rows.values()][0]!).manual.prepare).toEqual(request);
  expect(owner.prepare(request)).toBe(work);
  await expect(owner.prepare(caller)).rejects.toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  expect(f.prepare).not.toHaveBeenCalled();
  release(); await expect(work).rejects.toBe("AGENT_PREVIEW_SYNTHETIC_IO_ACK_LOST"); expect(f.prepare).toHaveBeenCalledExactlyOnceWith(request);
});
it("reopens an Unknown full manual intent and readonly NotFound does not replay or replace its W", async () => {
  const f = fixture(), owner = f.open(); await expect(owner.prepare(request)).rejects.toBeDefined(); owner.dispose();
  const reopened = f.open(); expect(reopened.restoreLocal(scope)).toBe(true); expect(f.status).not.toHaveBeenCalled();
  await expect(reopened.check(scope)).rejects.toBe("notFound"); expect(f.prepare).toHaveBeenCalledOnce();
  expect(reopened.getSnapshot()).toMatchObject({priorUnknown: true, recovery: {manual: {prepare: request}}});
  await expect(reopened.check({...scope, requestId: t})).rejects.toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  expect(f.status).toHaveBeenCalledOnce();
  f.prepare.mockResolvedValue(result); expect(await reopened.prepare(request)).toEqual(result);
  expect(f.prepare.mock.calls.map(([value]) => value)).toEqual([request, request]);
});
it("a real committed status restores the frozen preview without calling prepare, current model or context again", async () => {
  const f = fixture(), owner = f.open(); await expect(owner.prepare(request)).rejects.toBeDefined(); owner.dispose();
  f.status.mockImplementation(async intent => ({schemaVersion: 1, intent, status: {type: "committed", result,
    proof: {schemaVersion: 1, operationId: r, conversationId: c, family: "agent.writing.submission.prepare", epoch: t, sqlFence: "0", replayed: true, result: null}}}));
  const reopened = f.open(); reopened.restoreLocal(scope); expect(await reopened.check(scope)).toEqual(result);
  expect(f.status).toHaveBeenCalledExactlyOnceWith(request); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.gateway.start).not.toHaveBeenCalled();
});
it("local failure after committed ACK and failed terminal removal retry only local storage", async () => {
  const f = fixture(), owner = f.open(); f.prepare.mockResolvedValue(result); let flushes = 0;
  persistence(f.storage, async () => {if (++flushes === 2) throw new Error("local save failed");});
  await expect(owner.prepare(request)).rejects.toThrow("local save failed"); expect(owner.getSnapshot()).toMatchObject({phase: "localError", recovery: {manual: {result}}});
  await owner.retryLocal(); expect(owner.getSnapshot().phase).toBe("ready"); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.status).not.toHaveBeenCalled();
  let fail = true; persistence(f.storage, async () => {if (fail && f.rows.size === 0) throw new Error("remove not flushed");});
  expect(await owner.clear()).toBe(false); fail = false; await owner.retryLocal();
  expect(owner.getSnapshot().phase).toBe("done"); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.status).not.toHaveBeenCalled();
});
it("later prewrite rejection cannot erase prior Unknown or change its full intent", async () => {
  const f = fixture(), owner = f.open(); await expect(owner.prepare(request)).rejects.toBeDefined(); f.prepare.mockRejectedValue({code: "modelUnavailable"});
  await expect(owner.prepare(request)).rejects.toMatchObject({code: "modelUnavailable"});
  expect(owner.getSnapshot()).toMatchObject({phase: "unknown", priorUnknown: true, recovery: {manual: {knownRejected: false, prepare: request}}});
  const before = [...f.rows.values()][0]; await expect(owner.prepare({...request, expectedRevision: 18})).rejects.toThrow(); expect([...f.rows.values()][0]).toBe(before);
});
it("reopens a first proven materialization rejection with its diagnostic and only clears after readonly NotFound", async () => {
  const f = fixture(), owner = f.open(), cause = {code: "storage", reason: {conversationId: c, manuscriptId: m, requestId: r, operationId: r, code: "DATA_SQL_INVALID",
    reason: {operationId: r, epoch: null, sqlFence: null, phase: "writing-prepare-materialize", sqliteCode: null, sqliteExtendedCode: null, safeCause: "writing_context_budget_exceeded"}}};
  f.prepare.mockRejectedValue(cause); await expect(owner.prepare(request)).rejects.toEqual(cause); owner.dispose();
  const reopened = f.open(); reopened.restoreLocal(scope);
  expect(reopened.getSnapshot()).toMatchObject({priorUnknown: false, cause, recovery: {manual: {knownRejected: true, rejection: cause}}});
  await expect(reopened.check(scope)).rejects.toBe("notFound"); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.gateway.start).not.toHaveBeenCalled();
  expect(reopened.getSnapshot().cause).toEqual(cause);
  expect(await reopened.clear()).toBe(true); expect(f.rows.size).toBe(0); expect(f.status).toHaveBeenCalledExactlyOnceWith(request);
});
it("a failed first setItem dispatches nothing and an explicit retry can save the same original intent", async () => {
  const f = fixture(), owner = f.open(), write = f.storage.setItem.bind(f.storage); let fail = true;
  f.storage.setItem = (key, value) => {if (fail) throw new Error("quota"); write(key, value);};
  await expect(owner.prepare(request)).rejects.toThrow("quota"); expect(f.prepare).not.toHaveBeenCalled(); fail = false; f.prepare.mockResolvedValue(result);
  await expect(owner.prepare(request)).resolves.toEqual(result); expect(f.prepare).toHaveBeenCalledExactlyOnceWith(request);
});
it("legacy v1 does not acquire a full intent, and a late disposed ACK cannot replace R2", async () => {
  const f = fixture(), legacy = f.open(); f.store.save(scope); expect(legacy.restoreLocal(scope)).toBe(false);
  await expect(legacy.prepare(request)).rejects.toThrow("COMPACTION_RECOVERY_FULL_INTENT_MISSING"); expect(f.prepare).not.toHaveBeenCalled();
  const g = fixture(), owner = g.open(); let release!: (value: AgentWritingCompactionPreview) => void;
  g.prepare.mockImplementation(() => new Promise(resolve => {release = resolve;})); const work = owner.prepare(request);
  await vi.waitFor(() => expect(g.prepare).toHaveBeenCalledOnce()); owner.dispose(); const locator = [...g.rows.keys()][0]!;
  const newer = JSON.stringify({...JSON.parse(g.rows.get(locator)!), requestId: t, manual: {prepare: {...request, request: {...request.request, requestId: t}}, result: null, knownRejected: false, rejection: null}});
  g.rows.set(locator, newer); release(result); await expect(work).rejects.toThrow(); expect(g.rows.get(locator)).toBe(newer);
});
it("reads the captured gate after reliable persistence and can discard only the verified warm unsent request", async () => {
  const f = fixture(); let disabled = false, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;}); persistence(f.storage, () => gate);
  const owner = f.open(() => disabled), work = owner.prepare(request);
  const failure = expect(work).rejects.toBeInstanceOf(WritingCompactionAdmissionClosed);
  await vi.waitFor(() => expect(f.rows.size).toBe(1)); disabled = true; release(); await failure;
  expect(f.prepare).not.toHaveBeenCalled(); expect(owner.getSnapshot().priorUnknown).toBe(false);
  expect(owner.getAdmission()).toMatchObject({prepareMayHaveDispatched: false, blockedBeforeDispatch: "prepare"});
  expect(await owner.discardAdmissionBlock()).toBe(false);
  await owner.checkAdmissionBlock(); expect(await owner.discardAdmissionBlock()).toBe(true);
  expect(f.rows.size).toBe(0); expect(owner.unresolved()).toBe(false);
});
it("rechecks after the original sending publication without another callback before the RPC", async () => {
  const f = fixture(); let disabled = false;
  let owner!: WritingManualCompactionPreparation;
  owner = f.open(() => disabled, () => {if (owner.getSnapshot().phase === "sending") disabled = true;});
  await expect(owner.prepare(request)).rejects.toBeInstanceOf(WritingCompactionAdmissionClosed);
  expect(f.prepare).not.toHaveBeenCalled(); expect(owner.getAdmission().prepareMayHaveDispatched).toBe(false);
});
it("keeps a cold copy of an unsent locator uncertain even when Native reports NotFound", async () => {
  const f = fixture(), owner = f.open(() => true);
  await expect(owner.prepare(request)).rejects.toBeInstanceOf(WritingCompactionAdmissionClosed);
  const original = [...f.rows.values()][0]; owner.dispose();
  const cold = f.open(() => true); expect(cold.restoreLocal(scope)).toBe(true);
  await expect(cold.check(scope)).rejects.toBe("notFound");
  expect(cold.getAdmission()).toMatchObject({prepareMayHaveDispatched: true, startMayHaveDispatched: true, blockedBeforeDispatch: null});
  expect(await cold.discardAdmissionBlock()).toBe(false); expect([...f.rows.values()][0]).toBe(original);
  expect(f.prepare).not.toHaveBeenCalled();
});
it("retains failed warm removal and retries only the original local flush", async () => {
  const f = fixture(), owner = f.open(() => true);
  await expect(owner.prepare(request)).rejects.toBeInstanceOf(WritingCompactionAdmissionClosed); await owner.checkAdmissionBlock();
  let fail = true; persistence(f.storage, async () => {if (fail && f.rows.size === 0) throw new Error("flush failed");});
  expect(await owner.discardAdmissionBlock()).toBe(false); expect(owner.unresolved()).toBe(true);
  fail = false; await owner.retryLocal(); expect(owner.unresolved()).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.gateway.start).not.toHaveBeenCalled();
});
it("can explicitly replay a cold full Unknown preparation while disabled without changing its original request", async () => {
  const f = fixture(), owner = f.open(); await expect(owner.prepare(request)).rejects.toBeDefined(); owner.dispose();
  const cold = f.open(() => true); expect(cold.restoreLocal(scope)).toBe(true);
  f.prepare.mockResolvedValue(result); expect(await cold.prepare(request)).toEqual(result);
  expect(f.prepare.mock.calls.map(([value]) => value)).toEqual([request, request]);
  await expect(cold.prepare({...request, expectedRevision: request.expectedRevision + 1})).rejects.toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.gateway.start).not.toHaveBeenCalled();
});
