/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import type {AgentWritingQueuedCompactionPrepareRequest} from "@research-assistant/core/agent";
import {acquireWritingSubmissionController, releaseWritingSubmissionController} from "@research-assistant/workbench-sdk/agent-writing";
import {useWritingCompaction} from "./useWritingCompaction";
import {useWritingInputQueue} from "./useWritingInputQueue";
import {WritingCompactionFeedback} from "./WritingCompactionFeedback";
import {WritingRuntimeAdmissionScope} from "../persistence/writingRuntimeAdmission";
import {createWritingCompactionReceiptStore} from "./writingCompactionReceipt";
import {resetWritingCompactionOwnersForTests} from "./writingCompactionController";
import {executeWritingQueuedCompaction} from "./writingQueuedCompactionExecution";
import {createQueuedCompactionTestRuntime, resetQueuedCompactionTestOwners, queuedCompactionTestPersistence as persistence} from "../../../../../../apps/web/src/app/previews/agent/WritingQueuedCompaction.testSupport";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  resetWritingCompactionOwnersForTests(); resetQueuedCompactionTestOwners(); vi.restoreAllMocks();
});
async function action<T>(run: () => Promise<T>): Promise<T> {
  let result!: T; await act(async () => {result = await run();}); return result;
}
async function fixture() {
  const {storage, scope, runtime} = createQueuedCompactionTestRuntime(), inputId = crypto.randomUUID();
  runtime.setCompactionDuration(0);
  const queue = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: 0,
    edit: {type: "add", inputId, text: "/compact", userInput: []}});
  const request: AgentWritingQueuedCompactionPrepareRequest = {inputId, expectedQueueRevision: queue.revision,
    previousRequestId: null, expectedRevision: 0, submission: {conversationId: scope.conversationId, requestId: crypto.randomUUID(),
      text: "/compact", userInput: [], context: {manuscriptId: scope.manuscriptId, files: []},
      model: {providerId: "deepseek", modelId: "deepseek-v4-pro"}}};
  let disabled = false;
  const listeners = new Set<() => void>();
  const admission = {isDisabled: () => disabled, subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}};
  const ownerKey = JSON.stringify([runtime.identity, scope.manuscriptId, scope.conversationId]);
  const core = () => acquireWritingSubmissionController(ownerKey, runtime.gateways.submission, runtime.gateways.turns,
    runtime.queue.preview, {scope, storage}, admission.isDisabled);
  const receipts = createWritingCompactionReceiptStore(storage);
  const options = {scope: {identity: runtime.identity, ...scope}, gateway: runtime.compaction.gateway,
    turns: runtime.gateways.turns, history: runtime.history.gateway, receipts, queue: runtime.queue.gateway,
    submission: runtime.gateways.submission, queuePreview: runtime.queue.preview, submissionOwnerKey: ownerKey};
  const host = document.createElement("div"); let root = createRoot(host), mounted = false;
  let current!: ReturnType<typeof useWritingCompaction>, inputQueue!: ReturnType<typeof useWritingInputQueue>;
  function Harness() {
    current = useWritingCompaction(options);
    inputQueue = useWritingInputQueue(scope.manuscriptId, scope.conversationId, true, runtime.gateways.queue);
    return <WritingCompactionFeedback {...current}/>;
  }
  async function mount() {await act(async () => root.render(<WritingRuntimeAdmissionScope value={admission}><Harness/></WritingRuntimeAdmissionScope>)); mounted = true;}
  async function unmount() {if (mounted) {await act(async () => root.unmount()); mounted = false;}}
  async function reopen() {
    await unmount(); resetWritingCompactionOwnersForTests(); resetQueuedCompactionTestOwners();
    root = createRoot(host); await mount();
  }
  function setDisabled(value: boolean) {disabled = value; for (const listener of listeners) listener();}
  const prepareOriginal = runtime.compaction.gateway.prepareWritingQueued;
  const prepare = vi.spyOn(runtime.compaction.gateway, "prepareWritingQueued").mockImplementation(async value => {
    const prepared = await prepareOriginal(value); setDisabled(true); return prepared;
  });
  const cancelNative = runtime.queue.preview.cancel;
  const start = vi.spyOn(runtime.compaction.gateway, "start"), cancel = vi.spyOn(runtime.queue.preview, "cancel");
  const status = vi.spyOn(runtime.queue.preview, "cancelStatus"), settle = vi.spyOn(runtime.compaction.gateway, "settleWritingQueued");
  cleanups.push(async () => {await unmount(); runtime.dispose();});
  await mount();
  async function block() {
    expect(await action(() => current.executeQueued(request))).toBe(false);
    expect(current.state).toMatchObject({phase: "error", error: "startRejected", outcome: null});
    expect(current.queuedAdmission).toMatchObject({blockedBeforeDispatch: "start", startMayHaveDispatched: false});
    expect(start).not.toHaveBeenCalled();
  }
  return {scope, inputId, storage, runtime, receipts, request, ownerKey, core, options, host,
    get: () => current, queue: () => inputQueue, reopen, block, setDisabled, prepare, start, cancel, cancelNative, status, settle};
}

it("retires a prepared compact through the same Core owner after its first start is blocked", async () => {
  const f = await fixture(), owner = f.core();
  await f.block(); expect(f.host.textContent).toContain("放弃原准备");
  expect(await action(() => f.get().discardPreparation())).toBe(true);
  const intent = f.cancel.mock.calls[0]![0];
  expect(owner.isQueuedCancellationCommitted(intent)).toBe(true);
  expect(intent).toMatchObject({...f.scope, inputId: f.inputId, previewRequestId: f.request.submission.requestId});
  expect(f.get().state?.phase).toBe("idle"); expect(f.get().isPending()).toBe(false);
  expect(f.receipts.read(f.scope)).toBeNull(); expect(f.storage.length).toBe(0);
  const queue = await f.runtime.queue.gateway.read(f.scope);
  expect(queue).toMatchObject({paused: true, preparingInputId: null, inputs: [{inputId: f.inputId, text: "/compact"}]});
  expect(f.start).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
  releaseWritingSubmissionController(f.ownerKey, owner);
});

it("persists the original cancellation before RPC and retries that same intent after a save failure", async () => {
  const f = await fixture(); await f.block(); let failed = true;
  persistence(f.storage, async () => {if (failed && [...f.storage.values.keys()].some(key => key.includes("writing-queue-cancel"))) throw new Error("quota");});
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  expect(f.cancel).not.toHaveBeenCalled(); const intent = f.get().queuedCancellation?.intent;
  expect(intent?.previewRequestId).toBe(f.request.submission.requestId);
  failed = false; expect(await action(() => f.get().retry())).toBe(false);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(intent); expect(f.get().isPending()).toBe(false);
  expect(f.start).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
});

it("cold-opens a lost cancellation ACK by checking only the same Core operation and Native proof", async () => {
  const f = await fixture(); await f.block(); f.runtime.queue.failNextCancel("afterCommit");
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  const intent = f.cancel.mock.calls[0]![0]; expect(f.get().isPending()).toBe(true);
  await f.reopen();
  expect(f.status).toHaveBeenCalledExactlyOnceWith(intent); expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.get().state?.phase).toBe("idle"); expect(f.receipts.read(f.scope)).toBeNull();
  expect(f.start).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
});

it("cleans a cold compact locator from Native proof after Core already durably removed its own locator", async () => {
  const f = await fixture(); await f.block(); const owner = f.core();
  const queue = await f.runtime.queue.gateway.read(f.scope);
  await action(() => owner.beginPreparedQueueCancellation({...f.scope, inputId: f.inputId,
    previewRequestId: f.request.submission.requestId, requestId: crypto.randomUUID(), expectedRevision: queue.revision}));
  releaseWritingSubmissionController(f.ownerKey, owner);
  expect(f.receipts.read(f.scope)).not.toBeNull();
  await f.reopen();
  expect(f.get().isPending()).toBe(false); expect(f.receipts.read(f.scope)).toBeNull();
  expect(f.cancel).toHaveBeenCalledOnce(); expect(f.status).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});

it("retains the private owner when its cleanup flush fails and retries only cleanup", async () => {
  const f = await fixture(); await f.block(); let failed = true;
  persistence(f.storage, async () => {if (failed && f.storage.length === 0) throw new Error("private cleanup");});
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  expect(f.cancel).toHaveBeenCalledOnce(); expect(f.get().isPending()).toBe(true);
  failed = false; await action(() => f.get().retry());
  expect(f.get().isPending()).toBe(false); expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.start).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
});

it("keeps a foreign Core cancellation and the private compact locator intact", async () => {
  const f = await fixture(); await f.block(); const owner = f.core();
  const queue = await f.runtime.queue.gateway.read(f.scope);
  const foreign = {...f.scope, inputId: crypto.randomUUID(), previewRequestId: crypto.randomUUID(), requestId: crypto.randomUUID(), expectedRevision: queue.revision};
  await action(() => owner.beginPreparedQueueCancellation(foreign));
  const saved = [...f.storage.values];
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  expect([...f.storage.values]).toEqual(saved); expect(owner.getSnapshot().cancellation?.intent).toEqual(foreign);
  expect(f.get().isPending()).toBe(true); expect(f.cancel).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled();
  releaseWritingSubmissionController(f.ownerKey, owner);
});

it("uses Native retirement only for cleanup during passive execution, then explicitly creates a new R for the same I", async () => {
  const f = await fixture(); await f.block(); expect(await action(() => f.get().discardPreparation())).toBe(true);
  const execute = (explicit: boolean) => executeWritingQueuedCompaction({compaction: f.get(), ...f.scope, inputId: f.inputId,
    explicit, current: () => true, queueController: f.queue().controller,
    capture: async (requestId, previousRequestId, expectedQueueRevision, userInput) => f.get().executeQueued({
      ...f.request, previousRequestId, expectedQueueRevision, submission: {...f.request.submission, requestId, userInput}})});
  expect(await action(() => execute(false))).toBe(false); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled();
  f.prepare.mockRestore(); f.setDisabled(false);
  const nextPrepare = vi.spyOn(f.runtime.compaction.gateway, "prepareWritingQueued");
  expect(await action(() => execute(true))).toBe(true);
  const next = nextPrepare.mock.calls[0]![0];
  expect(next.inputId).toBe(f.inputId); expect(next.previousRequestId).toBe(f.request.submission.requestId);
  expect(next.submission.requestId).not.toBe(f.request.submission.requestId);
  expect(f.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId: next.submission.requestId}));
  expect(f.settle).toHaveBeenCalledOnce();
});

it("rebases cancellation only after a definitive Q conflict and keeps the full O2 identity", async () => {
  const f = await fixture(); await f.block();
  const original = f.cancelNative;
  f.cancel.mockImplementationOnce(async intent => {
    await f.runtime.queue.gateway.edit({...f.scope, requestId: crypto.randomUUID(), expectedRevision: intent.expectedRevision,
      edit: {type: "add", inputId: crypto.randomUUID(), text: "later tail"}});
    return original(intent);
  });
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  const first = f.cancel.mock.calls[0]![0];
  expect(await action(() => f.get().discardPreparation())).toBe(true);
  const second = f.cancel.mock.calls[1]![0];
  expect(second.requestId).not.toBe(first.requestId); expect(second.expectedRevision).toBe(first.expectedRevision + 1);
  expect({...second, requestId: first.requestId, expectedRevision: first.expectedRevision}).toEqual(first);
  const value = await f.runtime.compaction.gateway.readWritingQueued({...f.scope, inputId: f.inputId, requestId: first.previewRequestId});
  expect(value?.kind === "compact" && value.retirement?.intent).toEqual(second);
  expect(f.start).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
});

it("does not replace an unknown cancellation merely because Q advanced", async () => {
  const f = await fixture(); await f.block(); f.runtime.queue.failNextCancel("beforeCommit");
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  const first = f.cancel.mock.calls[0]![0];
  await f.runtime.queue.gateway.edit({...f.scope, requestId: crypto.randomUUID(), expectedRevision: first.expectedRevision,
    edit: {type: "add", inputId: crypto.randomUUID(), text: "later tail"}});
  await action(() => f.get().retry());
  expect(f.cancel.mock.calls.map(([intent]) => intent)).toEqual([first, first]);
  expect(f.get().isPending()).toBe(true); expect(f.start).not.toHaveBeenCalled(); expect(f.prepare).toHaveBeenCalledOnce();
});

it("preserves malformed Core cancellation data and its compact locator", async () => {
  const f = await fixture(); await f.block();
  const key = `research-assistant:writing-queue-cancel:v1:${f.scope.manuscriptId}:${f.scope.conversationId}`;
  f.storage.setItem(key, "{malformed");
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  expect(f.storage.getItem(key)).toBe("{malformed"); expect(f.receipts.read(f.scope)).not.toBeNull();
  expect(f.cancel).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});

it("keeps a cold active preview with no retirement proof unresolved and never labels its missing outcome as retirement", async () => {
  const f = await fixture(); await f.block(); await f.reopen();
  expect(f.get().state?.phase).toBe("preview"); expect(f.get().state?.outcome).toBeNull();
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  expect(f.get().isPending()).toBe(true); expect(f.receipts.read(f.scope)).not.toBeNull();
  expect(f.cancel).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});

it("joins concurrent retirement actions through the same Core operation", async () => {
  const f = await fixture(); await f.block(); let release!: () => void;
  persistence(f.storage, vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;})).mockResolvedValue(undefined));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  await act(async () => {first = f.get().discardPreparation(); second = f.get().discardPreparation();});
  expect(f.cancel).not.toHaveBeenCalled();
  await act(async () => {release(); await Promise.all([first, second]);});
  expect(f.cancel).toHaveBeenCalledOnce(); expect(f.get().isPending()).toBe(false); expect(f.start).not.toHaveBeenCalled();
});

it("keeps the original cancellation through a cold reopen during its reliable save and ignores the old late continuation", async () => {
  const f = await fixture(); await f.block(); let release!: () => void;
  persistence(f.storage, vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;})).mockResolvedValue(undefined));
  let pending!: Promise<boolean>;
  await act(async () => {pending = f.get().discardPreparation();});
  const original = f.get().queuedCancellation?.intent; expect(original).toBeTruthy();
  await f.reopen(); expect(f.cancel).not.toHaveBeenCalled(); expect(f.get().isPending()).toBe(true);
  await action(() => f.get().retry());
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(original); expect(f.get().isPending()).toBe(false);
  await act(async () => {release(); expect(await pending).toBe(false);});
  expect(f.cancel).toHaveBeenCalledOnce(); expect(f.storage.length).toBe(0); expect(f.start).not.toHaveBeenCalled();
});

it("retires an ambiguous start only after Native proves the exact unstarted cancellation, without fabricating an outcome", async () => {
  const f = await fixture(); await f.block(); f.setDisabled(false);
  f.runtime.compaction.failNext("start", "beforeCommit");
  expect(await action(() => f.get().retry())).toBe(false);
  expect(f.get().state).toMatchObject({phase: "error", error: "start", outcome: null});
  const owner = f.core(), queue = await f.runtime.queue.gateway.read(f.scope);
  await action(() => owner.beginPreparedQueueCancellation({...f.scope, inputId: f.inputId, requestId: crypto.randomUUID(),
    previewRequestId: f.request.submission.requestId, expectedRevision: queue.revision}));
  await action(() => f.get().checkPreparation());
  expect(f.get().state).toMatchObject({phase: "idle", outcome: null, admission: null});
  expect(f.get().isPending()).toBe(false); expect(f.start).toHaveBeenCalledOnce(); expect(f.settle).not.toHaveBeenCalled();
  releaseWritingSubmissionController(f.ownerKey, owner);
});

it("retains both recovery paths until Core's own committed cleanup is reliable", async () => {
  const f = await fixture(); await f.block(); let failed = true;
  persistence(f.storage, async () => {
    if (failed && f.cancel.mock.calls.length && f.storage.length === 1
      && ![...f.storage.values.keys()].some(key => key.includes("writing-queue-cancel"))) throw new Error("Core cleanup");
  });
  expect(await action(() => f.get().discardPreparation())).toBe(false);
  expect(f.get().queuedCancellation).toMatchObject({phase: "localError", knownCommitted: true});
  expect(f.receipts.read(f.scope)).not.toBeNull(); expect(f.get().isPending()).toBe(true);
  failed = false; await action(() => f.get().retry());
  expect(f.get().isPending()).toBe(false); expect(f.cancel).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled();
});

it("rejects a foreign Native retirement envelope before clearing the private locator", async () => {
  const f = await fixture(); await f.block(); const owner = f.core(), queue = await f.runtime.queue.gateway.read(f.scope);
  await action(() => owner.beginPreparedQueueCancellation({...f.scope, inputId: f.inputId, requestId: crypto.randomUUID(),
    previewRequestId: f.request.submission.requestId, expectedRevision: queue.revision}));
  releaseWritingSubmissionController(f.ownerKey, owner);
  const original = f.runtime.compaction.gateway.readWritingQueued;
  vi.spyOn(f.runtime.compaction.gateway, "readWritingQueued").mockImplementation(async request => {
    const value = await original(request);
    return value?.kind === "compact" && value.retirement ? {...value, retirement: {...value.retirement,
      intent: {...value.retirement.intent, inputId: crypto.randomUUID()}}} : value;
  });
  await f.reopen();
  expect(f.get().isPending()).toBe(true); expect(f.receipts.read(f.scope)).not.toBeNull();
  expect(f.cancel).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
});
