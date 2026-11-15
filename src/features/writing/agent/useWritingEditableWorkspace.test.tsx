/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import type {AgentInputDraft, AgentSubmissionPreview, AgentWorkspaceBuffer} from "@research-assistant/core/agent";
import {WritingSubmissionController} from "../../../../../../apps/web/src/core/features/agent/writingSubmissionController";
import {WritingDiffDemoStorage} from "../../../../../../apps/web/src/app/previews/agent/WritingDiffDemoStorage";
import {WritingDiffDemoAgentStorage} from "../../../../../../apps/web/src/app/previews/agent/WritingDiffDemoAgentStorage";
import {createWritingDiffDemoRuntime} from "../../../../../../apps/web/src/app/previews/agent/writingDiffDemoRuntime";
import {selectAppStorage} from "../../../../../../apps/web/src/core/runtime/appStorage";
import {registerStoragePersistence} from "../../../../../../apps/web/src/core/runtime/storagePersistence";
import {useWritingEditableWorkspace} from "./useWritingEditableWorkspace";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {return this.values.size;} key(index: number) {return [...this.values.keys()][index] ?? null;}
  getItem(key: string) {return this.values.get(key) ?? null;} setItem(key: string, value: string) {this.values.set(key, value);}
  removeItem(key: string) {this.values.delete(key);} clear() {this.values.clear();}
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks();});
async function fixture({queued = true, saveBuffers = true} = {}) {
  const storage = new MemoryStorage(); selectAppStorage(storage);
  const scope = {manuscriptId: crypto.randomUUID(), conversationId: crypto.randomUUID()}, inputId = crypto.randomUUID();
  const files = new WritingDiffDemoStorage(scope.manuscriptId, [{path: "main.tex", before: "before", after: "before", kind: "modified", additions: 0, deletions: 0}]);
  const agent = new WritingDiffDemoAgentStorage(files, undefined), runtime = createWritingDiffDemoRuntime(files, agent, scope.manuscriptId, scope.conversationId);
  const disk = await files.files.readFile(scope.manuscriptId, "main.tex"), revision = crypto.randomUUID();
  const buffers: readonly AgentWorkspaceBuffer[] = [{path: "main.tex", expectedDiskSha256: disk.sha256, sessionId: crypto.randomUUID(), revision, text: "original unsaved buffer"}];
  const request = {conversationId: scope.conversationId, requestId: crypto.randomUUID(), text: "read original", context: {manuscriptId: scope.manuscriptId,
    files: [{relativePath: "main.tex", expectedDiskSha256: disk.sha256, buffer: {revision, text: buffers[0]!.text}}]}};
  const makeOwner = () => new WritingSubmissionController(runtime.gateways.submission, runtime.gateways.turns, queued ? runtime.queue.preview : undefined, {scope, storage});
  const owners: WritingSubmissionController[] = [], owner = makeOwner(); owners.push(owner);
  if (queued) {
    const queue = await runtime.queue.gateway.edit({...scope, requestId: crypto.randomUUID(), expectedRevision: 0,
      edit: {type: "add", inputId, text: request.text, userInput: []}});
    await owner.prepareQueued(request, inputId, queue.revision, undefined, saveBuffers ? buffers : undefined);
  } else await owner.prepare(request);
  const preview = owner.getSnapshot().preview!; expect(preview).not.toBeNull();
  const controller = {current: owner as WritingSubmissionController | null};
  const frozenWorkspace = {current: null as {requestId: string; buffers: readonly AgentWorkspaceBuffer[] | null; draft: AgentInputDraft} | null};
  const gateway = {...runtime.gateways.workspace, prepare: vi.fn(runtime.gateways.workspace.prepare), restore: vi.fn(runtime.gateways.workspace.restore)};
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let current!: ReturnType<typeof useWritingEditableWorkspace>, mounted = true, activeGateway = gateway;
  function Harness() {current = useWritingEditableWorkspace({gateway: activeGateway, controller, frozenWorkspace}); return null;}
  await act(async () => root.render(<Harness/>));
  const unmount = async () => {if (mounted) {await act(async () => root.unmount()); mounted = false;}};
  cleanups.push(async () => {await unmount(); host.remove(); owners.forEach(value => value.dispose()); runtime.dispose();});
  return {scope, storage, runtime, owner, owners, controller, frozenWorkspace, gateway, preview, buffers, request, makeOwner,
    run: (value: AgentSubmissionPreview, options?: Parameters<typeof current>[1]) => current(value, options), unmount,
    replaceGateway: async (next: typeof gateway) => {activeGateway = next; await act(async () => root.render(<Harness/>));}};
}
it("readonly recovery preserves NotFound without preparing a copy or starting a task", async () => {
  const f = await fixture(), observer = vi.spyOn(f.owner, "observeWorkspacePreparation"), start = vi.spyOn(f.runtime.queue.preview, "start");
  expect(await f.run(f.preview, {restore: true})).toBe(false);
  expect(f.gateway.restore).toHaveBeenCalledExactlyOnceWith({conversationId: f.preview.conversationId, manuscriptId: f.preview.manuscriptId,
    requestId: f.preview.requestId, contextSnapshotId: f.preview.contextSnapshotId});
  expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(observer).toHaveBeenCalledExactlyOnceWith(f.preview.requestId, false, "notFound");
  expect(f.owner.getSnapshot()).toMatchObject({error: "workspace", workspaceFailure: "notFound"});
  expect(f.storage.length).toBe(1);
});
it("explicit continuation after reopen prepares only the original durable editor session and buffers", async () => {
  const f = await fixture(); f.owner.dispose(); const restored = f.makeOwner(); f.owners.push(restored);
  f.controller.current = restored; await restored.restoreQueuedPreparation();
  const prepare = vi.spyOn(f.runtime.queue.preview, "prepare"), start = vi.spyOn(f.runtime.queue.preview, "start");
  expect(await f.run(restored.getSnapshot().preview!, {restore: true, createMissing: true})).toBe(true);
  expect(f.gateway.prepare).toHaveBeenCalledExactlyOnceWith({scope: {conversationId: f.preview.conversationId, manuscriptId: f.preview.manuscriptId,
    requestId: f.preview.requestId, contextSnapshotId: f.preview.contextSnapshotId}, buffers: f.buffers});
  expect(prepare).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(f.storage.length).toBe(0);
  expect(restored.getSnapshot()).toMatchObject({phase: "preview", preparation: {phase: "complete"}});
});
it.each(["conflict", "denied", "unavailable"])("does not treat %s as an absent workspace and retains the original cause", async cause => {
  const f = await fixture(); f.gateway.restore.mockRejectedValueOnce(cause);
  expect(await f.run(f.preview, {restore: true, createMissing: true})).toBe(false);
  expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(f.owner.getSnapshot()).toMatchObject({error: "workspace", workspaceFailure: cause});
});
it("missing original session metadata cannot be reconstructed from a native text buffer", async () => {
  const f = await fixture({saveBuffers: false});
  expect(await f.run(f.preview, {restore: true, createMissing: true})).toBe(false);
  expect(f.gateway.prepare).not.toHaveBeenCalled();
  expect(f.owner.getSnapshot()).toMatchObject({error: "workspace", workspaceFailure: {code: "QUEUE_WORKSPACE_ORIGINAL_BUFFERS_MISSING"}});
});
it("workspace creation followed by failed local cleanup retries cleanup without recreating the workspace", async () => {
  const f = await fixture(); let failing = true;
  registerStoragePersistence(f.storage, {backend: "IndexedDB", pending: false, error: undefined, resetting: false,
    flush: async () => {if (failing && f.storage.length === 0) throw new Error("cleanup failed");}, retry: async () => {}, reset: vi.fn(),
    subscribe: vi.fn(() => () => {}), close: vi.fn()});
  expect(await f.run(f.preview, {restore: true, createMissing: true})).toBe(false);
  expect(f.owner.getSnapshot()).toMatchObject({error: "prepare", preparation: {knownCommitted: true, phase: "localError"}});
  failing = false;
  expect(await f.run(f.preview, {restore: true, createMissing: true})).toBe(true);
  expect(f.gateway.prepare).toHaveBeenCalledOnce(); expect(f.gateway.restore).toHaveBeenCalledOnce(); expect(f.storage.length).toBe(0);
});
it("a readonly restore completing after unmount cannot create a missing copy or notify the owner", async () => {
  const f = await fixture(); let reject!: (cause: unknown) => void;
  f.gateway.restore.mockImplementationOnce(() => new Promise((_, failed) => {reject = failed;}));
  const observer = vi.spyOn(f.owner, "observeWorkspacePreparation"), work = f.run(f.preview, {restore: true});
  await f.unmount(); reject("notFound"); expect(await work).toBe(false);
  expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
});
it("an explicitly continued original owner completes after view unmount without starting a new owner", async () => {
  const f = await fixture(); let reject!: (cause: unknown) => void;
  f.gateway.restore.mockImplementationOnce(() => new Promise((_, failed) => {reject = failed;}));
  const observer = vi.spyOn(f.owner, "observeWorkspacePreparation"), work = f.run(f.preview, {restore: true, createMissing: true});
  f.owner.detach(); f.controller.current = null; await f.unmount(); reject("notFound");
  expect(await work).toBe(true); expect(f.gateway.prepare).toHaveBeenCalledOnce();
  expect(observer).toHaveBeenCalledExactlyOnceWith(f.preview.requestId, true);
  expect(f.owner.getSnapshot()).toMatchObject({phase: "preview", preparation: {phase: "complete"}});
});
it("explicit continuation updates only the captured owner after the visible controller changes", async () => {
  const f = await fixture(); let reject!: (cause: unknown) => void;
  f.gateway.restore.mockImplementationOnce(() => new Promise((_, failed) => {reject = failed;}));
  const oldObserver = vi.spyOn(f.owner, "observeWorkspacePreparation"), work = f.run(f.preview, {restore: true, createMissing: true});
  const newer = new WritingSubmissionController(f.runtime.gateways.submission, f.runtime.gateways.turns); f.owners.push(newer);
  f.owner.detach(); f.controller.current = newer; const newObserver = vi.spyOn(newer, "observeWorkspacePreparation");
  reject("notFound"); expect(await work).toBe(true);
  expect(f.gateway.prepare).toHaveBeenCalledOnce(); expect(oldObserver).toHaveBeenCalledExactlyOnceWith(f.preview.requestId, true); expect(newObserver).not.toHaveBeenCalled();
});
it("readonly recovery cannot update an old live owner after the visible controller changes", async () => {
  const f = await fixture(); let reject!: (cause: unknown) => void;
  f.gateway.restore.mockImplementationOnce(() => new Promise((_, failed) => {reject = failed;}));
  const observer = vi.spyOn(f.owner, "observeWorkspacePreparation"), work = f.run(f.preview, {restore: true});
  const newer = new WritingSubmissionController(f.runtime.gateways.submission, f.runtime.gateways.turns); f.owners.push(newer);
  f.owner.detach(); f.controller.current = newer; reject("notFound");
  expect(await work).toBe(false); expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
});
it("fresh work may use its captured owner when native preparation outlives the original view", async () => {
  const f = await fixture(), newer = new WritingSubmissionController(f.runtime.gateways.submission, f.runtime.gateways.turns); f.owners.push(newer);
  f.owner.detach(); f.controller.current = newer;
  const oldObserver = vi.spyOn(f.owner, "observeWorkspacePreparation"), newObserver = vi.spyOn(newer, "observeWorkspacePreparation");
  expect(await f.run(f.preview, {owner: f.owner})).toBe(true);
  expect(f.gateway.prepare).toHaveBeenCalledOnce(); expect(oldObserver).toHaveBeenCalledExactlyOnceWith(f.preview.requestId, true); expect(newObserver).not.toHaveBeenCalled();
});
it("a captured owner does not authorize readonly checks outside its current view", async () => {
  const f = await fixture(), newer = new WritingSubmissionController(f.runtime.gateways.submission, f.runtime.gateways.turns); f.owners.push(newer);
  f.controller.current = newer;
  expect(await f.run(f.preview, {restore: true, owner: f.owner})).toBe(false);
  expect(f.gateway.restore).not.toHaveBeenCalled(); expect(f.gateway.prepare).not.toHaveBeenCalled();
});
it("fresh captured owner and buffers survive another conversation replacing the RAM snapshot", async () => {
  const f = await fixture({queued: false}), newer = new WritingSubmissionController(f.runtime.gateways.submission, f.runtime.gateways.turns); f.owners.push(newer);
  f.owner.detach(); f.controller.current = newer;
  f.frozenWorkspace.current = {requestId: crypto.randomUUID(), buffers: [], draft: {text: "another conversation", bindings: []}};
  expect(await f.run(f.preview, {owner: f.owner, buffers: f.buffers})).toBe(true);
  expect(f.gateway.prepare).toHaveBeenCalledExactlyOnceWith({scope: {conversationId: f.preview.conversationId, manuscriptId: f.preview.manuscriptId,
    requestId: f.preview.requestId, contextSnapshotId: f.preview.contextSnapshotId}, buffers: f.buffers});
});
it("explicit continuation freezes original buffers before a pending restore and view switch", async () => {
  const f = await fixture({queued: false}), original = structuredClone(f.buffers); let reject!: (cause: unknown) => void;
  f.frozenWorkspace.current = {requestId: f.preview.requestId, buffers: f.buffers, draft: {text: f.request.text, bindings: []}};
  f.gateway.restore.mockImplementationOnce(() => new Promise((_, failed) => {reject = failed;}));
  const work = f.run(f.preview, {restore: true, createMissing: true});
  f.frozenWorkspace.current = {requestId: crypto.randomUUID(), buffers: [], draft: {text: "new view", bindings: []}};
  (f.buffers[0] as {text: string}).text = "later editor content";
  f.controller.current = null; reject("notFound"); expect(await work).toBe(true);
  expect(f.gateway.prepare.mock.calls[0]![0].buffers).toEqual(original);
});
it("an old owner restore completing after owner replacement cannot create or mutate the new owner", async () => {
  const f = await fixture(); let reject!: (cause: unknown) => void;
  f.gateway.restore.mockImplementationOnce(() => new Promise((_, failed) => {reject = failed;}));
  const oldObserver = vi.spyOn(f.owner, "observeWorkspacePreparation"), work = f.run(f.preview, {restore: true, createMissing: true});
  f.owner.dispose(); const newer = f.makeOwner(); f.owners.push(newer); f.controller.current = newer;
  const newObserver = vi.spyOn(newer, "observeWorkspacePreparation"); reject("notFound");
  expect(await work).toBe(false); expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(oldObserver).not.toHaveBeenCalled(); expect(newObserver).not.toHaveBeenCalled();
});
it("a late successful workspace response cannot acknowledge a later R in the same owner", async () => {
  const f = await fixture({queued: false});
  const workspace = await f.runtime.gateways.workspace.prepare({scope: {conversationId: f.preview.conversationId, manuscriptId: f.preview.manuscriptId,
    requestId: f.preview.requestId, contextSnapshotId: f.preview.contextSnapshotId}, buffers: f.buffers});
  let finish!: (value: typeof workspace) => void;
  f.gateway.restore.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const observer = vi.spyOn(f.owner, "observeWorkspacePreparation"), work = f.run(f.preview, {restore: true, createMissing: true});
  await f.owner.abandonWritingPreparation(); await f.owner.prepare({...f.request, requestId: crypto.randomUUID()});
  const newer = f.owner.getSnapshot().preview!; expect(newer.requestId).not.toBe(f.preview.requestId);
  finish(workspace); expect(await work).toBe(false); expect(observer).not.toHaveBeenCalled();
  expect(f.owner.getSnapshot().preview?.requestId).toBe(newer.requestId); expect(f.gateway.prepare).not.toHaveBeenCalled();
});
it("changing the gateway blocks an authorized pending attempt before any new workspace write", async () => {
  const f = await fixture(); let reject!: (cause: unknown) => void;
  f.gateway.restore.mockImplementationOnce(() => new Promise((_, failed) => {reject = failed;}));
  const observer = vi.spyOn(f.owner, "observeWorkspacePreparation"), work = f.run(f.preview, {restore: true, createMissing: true});
  const newer = {...f.gateway, prepare: vi.fn(f.runtime.gateways.workspace.prepare), restore: vi.fn(f.runtime.gateways.workspace.restore)};
  await f.replaceGateway(newer); reject("notFound");
  expect(await work).toBe(false); expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(newer.prepare).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
});
it("fresh preparation uses the original RAM snapshot instead of recapturing a later editor state", async () => {
  const f = await fixture({queued: false});
  f.frozenWorkspace.current = {requestId: f.preview.requestId, buffers: f.buffers, draft: {text: "read original", bindings: []}};
  const durable = vi.spyOn(f.owner, "getWorkspaceBuffers");
  expect(await f.run(f.preview)).toBe(true); expect(f.gateway.restore).not.toHaveBeenCalled(); expect(durable).not.toHaveBeenCalled();
  expect(f.gateway.prepare.mock.calls[0]![0].buffers).toEqual(f.buffers);
});
it("a nonqueued workspace retry retains the same-R RAM buffers after readonly NotFound", async () => {
  const f = await fixture({queued: false});
  f.frozenWorkspace.current = {requestId: f.preview.requestId, buffers: f.buffers, draft: {text: "read original", bindings: []}};
  const durable = vi.spyOn(f.owner, "getWorkspaceBuffers");
  expect(await f.run(f.preview, {restore: true})).toBe(false);
  expect(await f.run(f.preview, {restore: true, createMissing: true})).toBe(true);
  expect(durable).not.toHaveBeenCalled(); expect(f.gateway.prepare).toHaveBeenCalledOnce();
  expect(f.gateway.prepare.mock.calls[0]![0].buffers).toEqual(f.buffers);
});
