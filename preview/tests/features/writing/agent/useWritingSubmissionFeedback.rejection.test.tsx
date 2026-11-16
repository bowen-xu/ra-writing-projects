/** @vitest-environment happy-dom */
import {act, createRef, useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import type {AgentInputDraft, AgentSubmissionPreview, AgentWritingPrepareRequest, AgentWritingStartRequest} from "@research-assistant/core/agent";
import {notify} from "@research-assistant/workbench-preview/feedback";
import {WritingSubmissionController, type WritingSubmissionSnapshot} from "@research-assistant/workbench-preview/writing-submission-controller";
import {useWritingSubmissionFeedback} from "@research-assistant/writing-projects-preview/use-writing-submission-feedback";

vi.mock("@research-assistant/workbench-preview/notifications", () => ({notify: {error: vi.fn(), dismiss: vi.fn()}}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {vi.clearAllMocks();});

async function mount(kind: "prepare" | "start", priorUnknown = false, recovered = false, deferred = false) {
  const originalDraft: AgentInputDraft = {text: "", bindings: []};
  let currentDraft = originalDraft;
  const original = {requestId: "request", conversationId: "conversation", context: {manuscriptId: "manuscript"}, text: "unsent", userInput: []};
  const preparing = {phase: priorUnknown ? "unknown" : "rejected", intent: original, recovered,
    knownRejected: !priorUnknown, priorUnknown, knownCommitted: kind === "start", result: null,
    start: kind === "start" ? {request: {}, knownRejected: !priorUnknown, priorUnknown, result: null} : null};
  let state = {phase: "error", error: kind === "start" ? "startRejected" : "prepare", writingPreparation: preparing} as unknown as WritingSubmissionSnapshot;
  const recover = vi.fn(), restore = vi.fn((draft: AgentInputDraft) => {currentDraft = draft;});
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const retire = vi.fn(async () => {if (deferred) await gate; state = {...state, writingPreparation: {...preparing, phase: "retired"}} as unknown as WritingSubmissionSnapshot;});
  const abandon = vi.fn(async () => {await retire(); return original.text;});
  const owner = {getSnapshot: () => state, hasWritingPreparation: () => true, hasQueuedPreparation: () => false,
    retireWritingPreparation: retire, abandonWritingPreparation: abandon, checkWritingPreparation: recover,
    retryWritingPreparation: vi.fn(), checkQueuedStart: vi.fn()} as unknown as WritingSubmissionController;
  const controller = createRef<WritingSubmissionController | null>(); controller.current = owner;
  const host = document.createElement("div"), root = createRoot(host);
  function Harness() {
    useWritingSubmissionFeedback({state, controller, draft: () => currentDraft, originalDraft, restore,
      prepareWorkspace: vi.fn(), holdPreparation: vi.fn(), onAdmitted: undefined, reload: vi.fn(), recover: vi.fn(), observedTurn: false});
    return null;
  }
  await act(async () => {root.render(<Harness/>);});
  return {retire, abandon, recover, restore, owner, root, originalDraft, release, setDraft: (draft: AgentInputDraft) => {currentDraft = draft;}};
}

it.each(["prepare", "start"] as const)("automatically returns a definitively rejected %s to its original draft", async kind => {
  const view = await mount(kind);
  expect(view.retire).toHaveBeenCalledOnce();
  expect(view.abandon).toHaveBeenCalledTimes(kind === "start" ? 1 : 0);
  expect(view.restore).toHaveBeenCalledOnce();
  expect(view.restore.mock.calls[0]?.[0].text).toBe("unsent");
  await act(async () => view.root.unmount());
});

it.each(["prepare", "start"] as const)("keeps an uncertain %s instead of retiring it or restoring its text", async kind => {
  const view = await mount(kind, true);
  expect(view.retire).not.toHaveBeenCalled();
  expect(view.abandon).not.toHaveBeenCalled();
  expect(view.restore).not.toHaveBeenCalled();
  expect(notify.error).toHaveBeenCalled();
  await act(async () => view.root.unmount());
});

it("keeps a recovered rejection for explicit reconciliation when the original live draft is not authoritative", async () => {
  const view = await mount("prepare", false, true);
  expect(view.retire).not.toHaveBeenCalled();
  expect(view.restore).not.toHaveBeenCalled();
  expect(notify.error).toHaveBeenCalled();
  await act(async () => view.root.unmount());
});

it("does not replace a newer draft while the rejection is being retired", async () => {
  const view = await mount("prepare", false, false, true);
  view.setDraft({text: "newer draft", bindings: []});
  await act(async () => {view.release();});
  expect(view.restore).not.toHaveBeenCalled();
  expect(notify.error).toHaveBeenCalledWith("请求核对失败，当前草稿已保留，请检查后重新发送。");
  await act(async () => view.root.unmount());
});

it.each([false, true])("handles real rejected start, with cleanup failure=%s", async cleanupFails => {
  const id = "11111111-1111-4111-8111-111111111111";
  const request: AgentWritingPrepareRequest = {conversationId: id, requestId: id, text: "Explain", context: {manuscriptId: id, files: [{relativePath: "main.tex", expectedDiskSha256: "hash"}]}};
  const preview: AgentSubmissionPreview = {schemaVersion: 1, conversationId: id, requestId: id, manuscriptId: id, contextSnapshotId: id, turnId: id,
    input: {text: request.text, model: {providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null}, reasoningEffort: null,
      context: [{sourceId: "file", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: JSON.stringify({manuscriptId: id}), text: "source"}]}};
  const values = new Map<string, string>();
  const storage: Storage = {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);}, removeItem: key => {if (cleanupFails) throw new Error("storage unavailable"); values.delete(key);}, clear: () => values.clear()};
  const gateway = {prepareWriting: vi.fn(async () => preview), prepareWritingStatus: vi.fn(async (intent: AgentWritingPrepareRequest) => ({schemaVersion: 1 as const, intent, status: {type: "notFound" as const}})),
    restoreWriting: vi.fn(async () => preview), startWriting: vi.fn().mockRejectedValue("modelUnavailable"),
    startStatus: vi.fn(async (intent: AgentWritingStartRequest) => ({schemaVersion: 1 as const, intent, status: {type: "prepared" as const, preview}}))};
  const turns = {interrupt: vi.fn(async () => ({schemaVersion: 1 as const, conversationId: id, turnId: id, cancellationRequested: true}))};
  const owner = new WritingSubmissionController(gateway, turns, undefined, {storage});
  const abandon = vi.spyOn(owner, "abandonWritingPreparation");
  await owner.prepare(request); await owner.observeWorkspacePreparation(id, true);
  const controller = createRef<WritingSubmissionController | null>(); controller.current = owner;
  const originalDraft: AgentInputDraft = {text: "", bindings: []}, restore = vi.fn(), host = document.createElement("div"), root = createRoot(host);
  function Harness() {
    const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
    useWritingSubmissionFeedback({state, controller, draft: () => originalDraft, originalDraft, restore,
      prepareWorkspace: vi.fn(), holdPreparation: vi.fn(), onAdmitted: undefined, reload: vi.fn(), recover: vi.fn(), observedTurn: false});
    return null;
  }
  await act(async () => {root.render(<Harness/>);});
  await act(async () => {await owner.confirm("deepSeekNonThinking");});
  await vi.waitFor(() => expect(owner.getSnapshot().writingPreparation?.phase).toBe(cleanupFails ? "localError" : "retired"));
  expect(abandon).toHaveBeenCalled();
  expect(gateway.startWriting).toHaveBeenCalledOnce();
  if (cleanupFails) {
    expect(values.size).toBe(1);
    expect(restore).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(notify.error).mock.calls.some(([, options]) =>
      options?.actions?.some(action => action.label === "核对原启动"))).toBe(true));
  } else {
    expect(values.size).toBe(0);
    expect(restore.mock.calls[0]?.[0].text).toBe("Explain");
  }
  await act(async () => root.unmount()); owner.dispose();
});

it.each([false, true])("handles real rejected preparation, with status failure=%s", async statusFails => {
  const id = "11111111-1111-4111-8111-111111111111";
  const request: AgentWritingPrepareRequest = {conversationId: id, requestId: id, text: "Explain", context: {manuscriptId: id, files: [{relativePath: "main.tex", expectedDiskSha256: "hash"}]}};
  const values = new Map<string, string>();
  const storage: Storage = {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);}, removeItem: key => {values.delete(key);}, clear: () => values.clear()};
  const gateway = {prepareWriting: vi.fn().mockRejectedValue("modelUnavailable"),
    prepareWritingStatus: vi.fn(async (intent: AgentWritingPrepareRequest) => {if (statusFails) throw new Error("status unavailable"); return {schemaVersion: 1 as const, intent, status: {type: "notFound" as const}};}),
    restoreWriting: vi.fn(), startWriting: vi.fn(), startStatus: vi.fn()};
  const turns = {interrupt: vi.fn(async () => ({schemaVersion: 1 as const, conversationId: id, turnId: id, cancellationRequested: true}))};
  const owner = new WritingSubmissionController(gateway, turns, undefined, {storage});
  const controller = createRef<WritingSubmissionController | null>(); controller.current = owner;
  const originalDraft: AgentInputDraft = {text: "", bindings: []}, restore = vi.fn(), root = createRoot(document.createElement("div"));
  function Harness() {
    const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
    useWritingSubmissionFeedback({state, controller, draft: () => originalDraft, originalDraft, restore,
      prepareWorkspace: vi.fn(), holdPreparation: vi.fn(), onAdmitted: undefined, reload: vi.fn(), recover: vi.fn(), observedTurn: false});
    return null;
  }
  await act(async () => {root.render(<Harness/>);});
  await act(async () => {await owner.prepare(request);});
  await vi.waitFor(() => expect(owner.getSnapshot().writingPreparation?.phase).toBe(statusFails ? "unknown" : "retired"));
  expect(gateway.prepareWriting).toHaveBeenCalledOnce();
  if (statusFails) {
    expect(values.size).toBe(1);
    expect(restore).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(notify.error).mock.calls.some(([, options]) =>
      options?.actions?.some(action => action.label === "核对原准备"))).toBe(true));
  } else {
    expect(values.size).toBe(0);
    expect(restore.mock.calls[0]?.[0].text).toBe("Explain");
  }
  await act(async () => root.unmount()); owner.dispose();
});

it("offers original return-to-queue retirement for a live locally blocked prepare without Native rejection", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const request: AgentWritingPrepareRequest = {conversationId: id, requestId: id, text: "Keep queued input", context: {manuscriptId: id, files: []}};
  const values = new Map<string, string>(), storage: Storage = {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value);}, removeItem: key => {values.delete(key);}, clear: () => values.clear()};
  const unused = async (): Promise<never> => {throw new Error("unexpected mutation");};
  const queue = {prepare: vi.fn(unused), prepareStatus: vi.fn(async (intent: import("@research-assistant/core/agent").AgentWritingQueuePreviewRequest) =>
    ({schemaVersion: 1 as const, intent, status: {type: "notFound" as const}})), recover: vi.fn(async () => null),
    start: vi.fn(unused), startStatus: vi.fn(unused), cancel: vi.fn(unused), cancelStatus: vi.fn(unused)};
  const owner = new WritingSubmissionController({prepareWriting: unused, prepareWritingStatus: unused, restoreWriting: unused, startWriting: unused, startStatus: unused},
    {interrupt: unused}, queue, {storage}, () => true);
  await owner.prepareQueued(request, id, 0);
  expect(owner.getSnapshot().preparation).toMatchObject({definitiveRejection: false, cause: {code: "WRITING_DISPATCH_ADMISSION_CLOSED"}});
  const controller = createRef<WritingSubmissionController | null>(); controller.current = owner;
  const hold = vi.fn(async () => {}), originalDraft: AgentInputDraft = {text: request.text, bindings: []}, root = createRoot(document.createElement("div"));
  function Harness() {
    const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
    useWritingSubmissionFeedback({state, controller, draft: () => originalDraft, originalDraft, restore: vi.fn(),
      prepareWorkspace: vi.fn(), holdPreparation: hold, onAdmitted: undefined, reload: async () => {}, recover: async () => {}, observedTurn: false});
    return null;
  }
  try {
    await act(async () => root.render(<Harness/>));
    const action = vi.mocked(notify.error).mock.calls.flatMap(([, options]) => options?.actions ?? []).find(action => action.label === "返回队列");
    expect(action).toBeDefined(); await act(async () => {await action?.onClick();});
    expect(queue.prepare).not.toHaveBeenCalled(); expect(queue.prepareStatus).toHaveBeenCalledOnce();
    expect(hold).toHaveBeenCalledOnce(); expect(owner.getSnapshot().preparation?.phase).toBe("retired"); expect(values.size).toBe(0);
  } finally {await act(async () => root.unmount()); owner.dispose();}
});
