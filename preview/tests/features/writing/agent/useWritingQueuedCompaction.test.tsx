/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentWritingQueuedCompactionPrepareRequest } from "@research-assistant/core/agent";
import { createWritingDiffDemoRuntime } from "@research-assistant/writing-projects-preview/writing-diff-demo-runtime";
import { WritingDiffDemoStorage } from "@research-assistant/writing-projects-preview/writing-diff-demo-storage";
import { WritingDiffDemoAgentStorage } from "@research-assistant/writing-projects-preview/writing-diff-demo-agent-storage";
import { selectAppStorage } from "@research-assistant/workbench-preview/app-storage";
import { registerStoragePersistence } from "@research-assistant/workbench-preview/storage-persistence";
import { createWritingCompactionReceiptStore } from "@research-assistant/writing-projects-preview/writing-compaction-receipt";
import { resetWritingCompactionOwnersForTests } from "@research-assistant/writing-projects-preview/writing-compaction-controller";
import { useWritingCompaction } from "@research-assistant/writing-projects-preview/use-writing-compaction";
import { useWritingInputQueue } from "@research-assistant/writing-projects-preview/use-writing-input-queue";
import { executeWritingQueuedCompaction, recoverWritingQueueCompaction } from "@research-assistant/writing-projects-preview/writing-queued-compaction-execution";
import { notify } from "@research-assistant/workbench-preview/feedback";
import { WritingCompactionFeedback } from "@research-assistant/writing-projects-preview/writing-compaction-feedback";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const manuscriptId = "11111111-1111-4111-8111-111111111111", conversationId = "22222222-2222-4222-8222-222222222222";
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {return this.values.size;}
  key(index: number) {return [...this.values.keys()][index] ?? null;}
  getItem(key: string) {return this.values.get(key) ?? null;}
  setItem(key: string, value: string) {this.values.set(key, value);}
  removeItem(key: string) {this.values.delete(key);}
  clear() {this.values.clear();}
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0)) await cleanup(); resetWritingCompactionOwnersForTests(); vi.useRealTimers(); vi.restoreAllMocks();});
async function fixture() {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn(async (_value: string) => undefined);
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});
  cleanups.push(async () => {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  const storage = new MemoryStorage(); selectAppStorage(storage);
  const files = new WritingDiffDemoStorage(manuscriptId, []), agent = new WritingDiffDemoAgentStorage(files, undefined);
  const runtime = createWritingDiffDemoRuntime(files, agent, manuscriptId, conversationId); runtime.setCompactionDuration(0);
  const receipts = createWritingCompactionReceiptStore(storage), inputId = crypto.randomUUID();
  const added = await runtime.queue.gateway.edit({manuscriptId, conversationId, requestId: crypto.randomUUID(), expectedRevision: 0,
    edit: {type: "add", inputId, text: "/compact", userInput: []}});
  const request: AgentWritingQueuedCompactionPrepareRequest = {inputId, expectedQueueRevision: added.revision, previousRequestId: null,
    expectedRevision: 0, submission: {conversationId, requestId: crypto.randomUUID(), text: "/compact", userInput: [], context: {manuscriptId, files: []},
      model: {providerId: "deepseek", modelId: "deepseek-v4-pro"}}};
  const options = {scope: {identity: runtime.identity, conversationId, manuscriptId}, gateway: runtime.compaction.gateway,
    history: runtime.history.gateway, turns: runtime.gateways.turns, queue: runtime.queue.gateway, receipts,
    submission: runtime.gateways.submission, queuePreview: runtime.queue.preview};
  const host = document.createElement("div");
  let root = createRoot(host), current!: ReturnType<typeof useWritingCompaction>, queue!: ReturnType<typeof useWritingInputQueue>, mounted = false;
  function Harness() {current = useWritingCompaction(options); queue = useWritingInputQueue(manuscriptId, conversationId, true, runtime.gateways.queue); return <WritingCompactionFeedback {...current}/>;}
  async function mount() {await act(async () => root.render(<Harness/>)); mounted = true;}
  async function unmount() {if (mounted) {await act(async () => root.unmount()); mounted = false;}}
  async function reopen() {await unmount(); resetWritingCompactionOwnersForTests(); root = createRoot(host); await mount();}
  cleanups.push(async () => {await unmount(); runtime.dispose();});
  await mount();
  const diagnostic = async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="复制诊断信息"]')!.click());
    return writeText.mock.lastCall?.[0] ?? "";
  };
  return {host, storage, runtime, receipts, request, options, get: () => current, queue: () => queue, reopen, diagnostic};
}
async function result(action: () => Promise<boolean>): Promise<boolean> {
  let work!: Promise<boolean>; await act(async () => {work = action();});
  let value = false; await act(async () => {value = await work;}); return value;
}

it("persists the complete normalized prepare before dispatch and blocks RPC on failed durable flush", async () => {
  const f = await fixture(), prepare = vi.spyOn(f.runtime.compaction.gateway, "prepareWritingQueued");
  let failed = true;
  const flush = vi.fn(async () => {if (failed) throw new Error("quota");});
  const retry = vi.fn(async () => {failed = false;});
  registerStoragePersistence(f.storage, {backend: "IndexedDB", pending: false, resetting: false, get error() {return failed ? new Error("quota") : undefined;},
    flush, retry, reset: vi.fn(), subscribe: vi.fn(() => () => {}), close: vi.fn()});
  expect(await result(() => f.get().executeQueued(f.request))).toBe(false); expect(prepare).not.toHaveBeenCalled();
  const saved = f.receipts.read(f.options.scope)!; expect(saved.requestId).toBe(f.request.submission.requestId);
  expect(f.get().queuedRecovery?.queued.prepare).toMatchObject(f.request); expect(f.get().isPending()).toBe(true);
  expect(await result(() => f.get().retry())).toBe(true); expect(retry).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0]![0]).toEqual(f.get().state?.request && {...f.get().state!.request!.queued,
    submission: f.get().state!.request!.request, expectedRevision: f.get().state!.request!.expectedRevision});
  expect(flush.mock.invocationCallOrder[1]).toBeLessThan(prepare.mock.invocationCallOrder[0]!);
});

it("reopens a lost prepare acknowledgement without starting, then explicitly continues the original R and W", async () => {
  const f = await fixture(); f.runtime.compaction.failNext("prepare", "afterCommit");
  const prepare = vi.spyOn(f.runtime.compaction.gateway, "prepareWritingQueued"), start = vi.spyOn(f.runtime.compaction.gateway, "start");
  expect(await result(() => f.get().executeQueued(f.request))).toBe(false); expect(start).not.toHaveBeenCalled();
  const saved = f.get().queuedRecovery!; await f.reopen();
  expect(f.get().state).toMatchObject({phase: "preview", preview: {requestId: saved.requestId, expectedRevision: f.request.expectedRevision}});
  expect(start).not.toHaveBeenCalled(); expect(await result(() => f.get().retry())).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId: saved.requestId, expectedRevision: f.request.expectedRevision}));
});

it("retains an unknown settle operation across reopen and replays only that exact operation", async () => {
  const f = await fixture(); f.runtime.compaction.failNext("settle", "afterCommit");
  const settle = vi.spyOn(f.runtime.compaction.gateway, "settleWritingQueued"), start = vi.spyOn(f.runtime.compaction.gateway, "start");
  expect(await result(() => f.get().executeQueued(f.request))).toBe(false);
  const original = settle.mock.calls[0]![0]; expect((await f.runtime.queue.gateway.read(f.options.scope)).inputs).toEqual([]);
  await f.reopen(); expect(f.get().queuedRecovery?.queued.settle).toEqual(original);
  expect(await result(() => f.get().retry())).toBe(true); expect(settle.mock.calls.map(([request]) => request)).toEqual([original, original]);
  expect(start).toHaveBeenCalledTimes(1); expect(f.get().queuedRecovery).toBeNull();
});

it("uses the exact compact history terminal when a start acknowledgement is lost, without replaying start", async () => {
  const f = await fixture(); vi.useFakeTimers(); f.runtime.setCompactionDuration(10_000); f.runtime.compaction.failNext("start", "afterCommit");
  const prepare = vi.spyOn(f.runtime.compaction.gateway, "prepareWritingQueued"), start = vi.spyOn(f.runtime.compaction.gateway, "start"),
    settle = vi.spyOn(f.runtime.compaction.gateway, "settleWritingQueued");
  expect(await result(() => f.get().executeQueued(f.request))).toBe(false);
  expect(f.get().isPending()).toBe(true);
  expect(await result(() => f.get().executeQueued({...f.request, submission: {...f.request.submission, requestId: crypto.randomUUID()}}))).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(f.get().state?.outcome).toBe("completed"); expect(f.get().queuedRecovery?.requestId).toBe(f.request.submission.requestId);
  expect(await result(() => f.get().retry())).toBe(true);
  expect(prepare).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce();
  expect(settle.mock.calls[0]![0].requestId).toBe(f.request.submission.requestId);
  expect(f.receipts.read(f.options.scope)).toBeNull(); expect(f.get().isPending()).toBe(false);
});

it("uses a new settle operation only after a proven CAS rejection, keeping I/R/claim unchanged", async () => {
  const f = await fixture(), settle = vi.spyOn(f.runtime.compaction.gateway, "settleWritingQueued");
  settle.mockRejectedValueOnce({code: "conflict"}); expect(await result(() => f.get().executeQueued(f.request))).toBe(false);
  const first = settle.mock.calls[0]![0]; expect(f.get().queuedRecovery?.queued.settle).toBeNull();
  expect(await result(() => f.get().retry())).toBe(true); const second = settle.mock.calls[1]![0];
  expect(second.operationId).not.toBe(first.operationId); expect({...second, operationId: first.operationId}).toEqual(first);
});

it("retries only local cleanup after a known settlement ACK, without another native mutation", async () => {
  const f = await fixture(), settle = vi.spyOn(f.runtime.compaction.gateway, "settleWritingQueued");
  const flush = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("cleanup failed")).mockResolvedValue(undefined);
  registerStoragePersistence(f.storage, {backend: "IndexedDB", pending: false, resetting: false, error: undefined, flush,
    retry: vi.fn(), reset: vi.fn(), subscribe: vi.fn(() => () => {}), close: vi.fn()});
  expect(await result(() => f.get().executeQueued(f.request))).toBe(false); expect(f.get().isPending()).toBe(true);
  expect(await result(() => f.get().retry())).toBe(true); expect(settle).toHaveBeenCalledTimes(1); expect(f.get().isPending()).toBe(false);
});

it("keeps failed typed discovery read-only instead of routing the pending I to ordinary recovery", async () => {
  const f = await fixture(), error = vi.spyOn(notify, "error").mockReturnValue(1);
  const prepare = vi.spyOn(f.runtime.compaction.gateway, "prepareWritingQueued"), start = vi.spyOn(f.runtime.compaction.gateway, "start");
  vi.spyOn(f.runtime.compaction.gateway, "readWritingQueued").mockRejectedValueOnce({code: "unavailable", message: "PRIVATE_SOURCE_BODY"});
  await f.reopen();
  expect(await recoverWritingQueueCompaction(f.get(), {conversationId, manuscriptId}, f.request.inputId, f.queue().controller)).toBe(true);
  expect(prepare).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(f.receipts.read(f.options.scope)).toBeNull();
  const message = error.mock.calls[0]![0]; expect(message).toContain("错误码：unavailable"); expect(message).toContain(`I=${f.request.inputId}`);
  expect(message).not.toContain("PRIVATE_SOURCE_BODY");
});

it("ignores a late discovery after the queue host detaches, without writing a locator or starting", async () => {
  const f = await fixture(), original = await f.runtime.compaction.gateway.prepareWritingQueued(f.request);
  let resolve!: (value: typeof original) => void;
  vi.spyOn(f.runtime.compaction.gateway, "readWritingQueued").mockReturnValueOnce(new Promise(yes => {resolve = yes;}));
  await f.reopen();
  const start = vi.spyOn(f.runtime.compaction.gateway, "start"), ref = f.queue().controller;
  const reading = recoverWritingQueueCompaction(f.get(), {conversationId, manuscriptId}, f.request.inputId, ref);
  await f.reopen(); resolve(original); expect(await reading).toBe(true);
  expect(start).not.toHaveBeenCalled(); expect(f.receipts.read(f.options.scope)).toBeNull(); expect(f.get().state?.phase).toBe("idle");
});

it("discloses a running compact reader's persistence failure and retries only the original history", async () => {
  const f = await fixture(); vi.useFakeTimers(); f.runtime.setCompactionDuration(20_000);
  let rejectHistory!: (cause: unknown) => void;
  vi.spyOn(f.runtime.history.gateway, "waitForHistory").mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectHistory = reject;}));
  const open = vi.spyOn(f.runtime.history.gateway, "open"), prepare = vi.spyOn(f.runtime.compaction.gateway, "prepareWritingQueued"),
    start = vi.spyOn(f.runtime.compaction.gateway, "start"), settle = vi.spyOn(f.runtime.compaction.gateway, "settleWritingQueued");
  let running!: Promise<boolean>;
  await act(async () => {running = f.get().executeQueued(f.request);});
  expect(f.get().state).toMatchObject({phase: "started", outcome: null});
  await act(async () => rejectHistory({code: "data_persistence_failed",
    message: "DATA_RUNTIME_ADMISSION: position=7; data_recovery_required: reopen the data owner before continuing"}));
  expect(f.get().history?.status).toBe("error"); expect(f.get().state?.outcome).toBeNull();
  expect(f.host.textContent).toContain("尚未确认执行是否结束");
  const diagnostic = await f.diagnostic();
  for (const code of ["data_persistence_failed", "DATA_RUNTIME_ADMISSION", "data_recovery_required"])
    expect(diagnostic).toContain(code);
  for (const identity of [`C=${conversationId}`, `R=${f.request.submission.requestId}`, `I=${f.request.inputId}`]) expect(diagnostic).toContain(identity);
  const reread = [...f.host.querySelectorAll("button")].find(button => button.textContent === "重新读取原请求历史")!;
  expect(reread).toBeDefined(); await act(async () => reread.click());
  expect(open).toHaveBeenCalledTimes(2); expect(prepare).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce(); expect(settle).not.toHaveBeenCalled();
  expect(f.get().state).toMatchObject({phase: "started", outcome: null}); expect(f.receipts.read(f.options.scope)?.requestId).toBe(f.request.submission.requestId);
  expect(f.get().history?.projection?.turnOrder).toHaveLength(1);
  await act(async () => {await vi.advanceTimersByTimeAsync(20_000); expect(await running).toBe(true);});
});

it("keeps a restored queued preview's history retry read-only before any start", async () => {
  const f = await fixture(); f.runtime.compaction.failNext("prepare", "afterCommit");
  expect(await result(() => f.get().executeQueued(f.request))).toBe(false);
  vi.spyOn(f.runtime.history.gateway, "open").mockRejectedValueOnce({code: "data_persistence_failed", message: "DATA_RUNTIME_ADMISSION: data_recovery_required"});
  const start = vi.spyOn(f.runtime.compaction.gateway, "start"), settle = vi.spyOn(f.runtime.compaction.gateway, "settleWritingQueued");
  await f.reopen(); expect(f.get().state?.phase).toBe("preview"); expect(f.get().history?.status).toBe("error");
  const reread = [...f.host.querySelectorAll("button")].find(button => button.textContent === "重新读取原请求历史")!;
  expect(reread).toBeDefined(); await act(async () => reread.click());
  expect(f.get().history?.status).toBe("ready"); expect(f.get().state).toMatchObject({phase: "preview", outcome: null});
  expect(start).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled(); expect(f.receipts.read(f.options.scope)?.requestId).toBe(f.request.submission.requestId);
});

it.each(["failed", "canceled", "interrupted"] as const)("starts a fresh R only on an explicit action after a released %s execution and reliable local cleanup", async outcome => {
  const f = await fixture(); f.runtime.compaction.nextOutcome = outcome;
  const prepare = vi.spyOn(f.runtime.compaction.gateway, "prepareWritingQueued"), settle = vi.spyOn(f.runtime.compaction.gateway, "settleWritingQueued");
  expect(await result(() => f.get().executeQueued(f.request))).toBe(false);
  expect(f.receipts.read(f.options.scope)).toBeNull(); expect(f.get().isPending()).toBe(false);
  expect(await f.runtime.compaction.gateway.readWritingQueued({conversationId, manuscriptId, inputId: f.request.inputId, requestId: null}))
    .toMatchObject({kind: "compact", current: false, outcome, requestId: f.request.submission.requestId});
  const capture = vi.fn((requestId: string, previousRequestId: string | null, expectedQueueRevision: number) => f.get().executeQueued({
    ...f.request, previousRequestId, expectedQueueRevision, submission: {...f.request.submission, requestId},
    expectedRevision: f.get().history?.projection?.seq ?? 0,
  }));
  const execute = (explicit: boolean) => executeWritingQueuedCompaction({compaction: f.get(), ...f.options.scope,
    inputId: f.request.inputId, explicit, current: () => true, queueController: f.queue().controller, capture});
  expect(await result(() => execute(false))).toBe(false); expect(capture).not.toHaveBeenCalled();
  expect(await result(() => execute(true))).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(2); expect(settle).toHaveBeenCalledTimes(2);
  const next = prepare.mock.calls[1]![0]; expect(next.inputId).toBe(f.request.inputId);
  expect(next.previousRequestId).toBe(f.request.submission.requestId); expect(next.submission.requestId).not.toBe(f.request.submission.requestId);
  expect((await f.runtime.queue.gateway.read(f.options.scope)).inputs).toEqual([]);
});
