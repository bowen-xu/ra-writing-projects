import type {ConversationDraftStore as ConversationDraftPort} from "@research-assistant/workbench-sdk/agent-drafts";
import type { AgentContextGateway } from "@research-assistant/workbench-preview/agent-context-gateway";
import { createMockContextConfiguration } from "@research-assistant/writing-projects-preview/mock-context-configuration";
import { createMockContextConfigurationAuthority } from "@research-assistant/writing-projects-preview/mock-context-configuration-authority";
/** @vitest-environment happy-dom */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentInputQueueRegistry, AgentSteeringRegistry, AgentSteeringHandoffRegistry, type AgentSteeringHandoffGateway, type AgentInputQueueGateway, type AgentSteeringGateway, type AgentSubmissionGateway, type AgentTurnGateway, type AgentWorkspaceGateway, type AgentForkOriginGateway, type AgentWorkspaceReviewGateway } from "@research-assistant/data/agent";
import { EMPTY_AGENT_CONTEXT, createAgentConversationProjection, insertAgentReference, serializeAgentSourceReferences, type AgentWritingQueueResponse, type AgentWritingStartResponse, type AgentReferenceInput } from "@research-assistant/core/agent";
import type { LlmConfiguration } from "@research-assistant/core/ai";
import { parseManuscriptPath } from "@research-assistant/writing";
import { invoke } from "@tauri-apps/api/core";
import { WritingAgentRuntimePanel, resetWritingRetrievalOwnersForTests } from "@research-assistant/writing-projects-preview/writing-agent-runtime-panel";
import type { WritingAgentRuntimeGateways, WritingSteeringScope } from "@research-assistant/writing-projects-preview/writing-runtime-gateways";
import { createMockAgentResourceGateways } from "@research-assistant/writing-projects-preview/mock-agent-resource-gateways";
import { WritingFileSessions } from "@research-assistant/writing-projects-preview/writing-file-sessions";
import { captureWritingEditor } from "@research-assistant/writing-projects-preview/editor-session";
import { AgentDraftProvider, useAgentDraftStore } from "@research-assistant/workbench-preview/agent-draft-provider";
import { ConversationDraftStore, conversationDraftKey } from "@research-assistant/workbench-preview/conversation-draft-store";
import { localConversationDraftPersistence, type ConversationDraftPersistence } from "@research-assistant/workbench-preview/conversation-draft-persistence";
import { AgentQueueProvider } from "@research-assistant/workbench-preview/agent-queue-provider";
import { AgentSteeringProvider } from "@research-assistant/workbench-preview/agent-steering-provider";
import { resetWritingSubmissionControllersForTests } from "@research-assistant/workbench-preview/writing-submission-controller";
import { WritingDiffDemoQueue } from "@research-assistant/workbench-preview/writing-diff-demo-queue";
import { getAppStorage,selectAppStorage } from "@research-assistant/workbench-preview/app-storage";
import { notify } from "@research-assistant/workbench-preview/feedback";
import { recommendationDraftKey, recommendationSubmissionKey } from "@research-assistant/workbench-preview/context-recommendation-draft";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("Unexpected native I/O"); }), isTauri: () => true }));
vi.mock("@research-assistant/workbench-preview/notifications", () => ({ notify: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const manuscriptId = "11111111-1111-4111-8111-111111111111";
const conversationA = "22222222-2222-4222-8222-222222222222";
const conversationB = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const configuration: LlmConfiguration = {
  providers: [{ providerId: "deepseek", displayName: "Mock DeepSeek", authMode: "api-key", protocol: "openai-compatible",
    modelKinds: ["text"], defaultBaseUrls: [], baseUrl: "", usesDefaultBaseUrl: true, enabled: true, timeoutMs: 60000, credentialConfigured: true }],
  defaultModels: [{ routeKind: "default", routeId: "text", label: "文本模型", modelKind: "text", selection: { providerId: "deepseek", modelId: "deepseek-v4-pro" } }],
  useCases: [],
};
const unavailable = async (): Promise<never> => { throw new Error("Operation not used by this fixture"); };
function fixture(identity = crypto.randomUUID()) {
  const queueGateway = { read: vi.fn<AgentInputQueueGateway["read"]>(async (scope): Promise<AgentWritingQueueResponse> => ({ schemaVersion: 1, ...scope,
    revision: 0, paused: true, preparingInputId: null, inputs: [] })), edit: vi.fn<AgentInputQueueGateway["edit"]>(unavailable) };
  const send = vi.fn<AgentSteeringGateway["steerWriting"]>(unavailable);
  const handoff: AgentSteeringHandoffGateway = {read: async conversationId => ({schemaVersion: 1, conversationId, epoch: identity, items: []}),
    prepare: unavailable, resolution: unavailable, finish: unavailable, release: unavailable, cancelUnregistered: unavailable};
  const handoffRegistry = new AgentSteeringHandoffRegistry(handoff, unavailable, () => crypto.randomUUID());
  const gateways: WritingAgentRuntimeGateways = {
    context:{...createMockContextConfiguration(getAppStorage()),steeringHandoff:handoff,sessions:{},list:async()=>[],search:async()=>[],catalog:async()=>[],prepare:unavailable,restore:unavailable,start:unavailable,interrupt:unavailable} as unknown as AgentContextGateway,
    steeringHandoff: handoffRegistry,
    resources: createMockAgentResourceGateways(),
    identity,
    submission: {
      prepareWritingStatus: vi.fn(unavailable),
      startStatus: vi.fn<AgentSubmissionGateway["startStatus"]>(unavailable),
      prepareWriting: vi.fn<AgentSubmissionGateway["prepareWriting"]>(async request => ({ schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId,
        manuscriptId, turnId, contextSnapshotId: crypto.randomUUID(), input: { text: request.text, reasoningEffort: null,
          model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, context: request.context.files.map(file => ({ sourceId: file.relativePath,
            kind: "manuscript" as const, resourceId: file.relativePath, revision: file.expectedDiskSha256,
            anchor: JSON.stringify({ manuscriptId }), text: file.buffer?.text ?? "" })) } })),
      startWriting: vi.fn<AgentSubmissionGateway["startWriting"]>(async request => ({ schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId,
        turnId, alreadyStarted: false, outcome: null })), restoreWriting: vi.fn(unavailable),
    },
    turns: { interrupt: vi.fn<AgentTurnGateway["interrupt"]>(async request => ({ schemaVersion: 1, ...request, cancellationRequested: true })) },
    queuePreview: { prepare: vi.fn(unavailable), recover: vi.fn(unavailable), cancel: vi.fn(unavailable), prepareStatus: vi.fn(), cancelStatus: vi.fn(unavailable), start: vi.fn(unavailable), startStatus: vi.fn(unavailable) },
    queue: { gateway: queueGateway, registry: new AgentInputQueueRegistry(queueGateway,
      scope => JSON.stringify([scope.manuscriptId, scope.conversationId]), () => crypto.randomUUID()) },
    steering: { send, registry: new AgentSteeringRegistry<WritingSteeringScope>(send, () => crypto.randomUUID()) },
    workspace: { prepare: vi.fn<AgentWorkspaceGateway["prepare"]>(async request => ({ schemaVersion: 1, ...request.scope, turnId, leaseId: crypto.randomUUID(),
      manifestHash: "a".repeat(64), policy: "offline_workspace_v1", approved: false, files: [] })),
      restore: vi.fn(unavailable), approve: vi.fn(unavailable), revoke: vi.fn(unavailable) },
    creation: { createBound: vi.fn(unavailable), createBoundStatus: vi.fn(unavailable) }, metadata: { read: vi.fn(unavailable) }, catalog: { rename: vi.fn(unavailable), renameStatus: vi.fn(unavailable) },
    subtasks: { list: vi.fn(async () => []), reconcile: vi.fn(unavailable), resumeWriting: vi.fn(unavailable) },
    fork: { fork: vi.fn(unavailable), status: vi.fn(unavailable) }, forkOrigin: { read: vi.fn<AgentForkOriginGateway["read"]>(async request => ({ schemaVersion: 1, conversationId: request.conversationId, origin: null })) },
    retrieval: { previewConceptRetrieval: vi.fn(unavailable), cancelConceptRetrievalPreview: vi.fn(unavailable) },
    model: { getLlmConfiguration: vi.fn(async () => configuration), fetchLlmProviderModels: vi.fn<WritingAgentRuntimeGateways["model"]["fetchLlmProviderModels"]>(async () => ({ providerId: "deepseek", models: [
      { id: "deepseek-v4-pro", displayName: "Mock DeepSeek V4 Pro", description: "", isDefault: true, supportedReasoningEfforts: [] },
    ] })) },
    review: { workspaceDiscardGateway: { find: vi.fn(unavailable), preview: vi.fn(unavailable), discard: vi.fn(unavailable) }, workspaceReviewGateway: { list: vi.fn<AgentWorkspaceReviewGateway["list"]>(async () => ({ schemaVersion: 1, entries: [], nextCursor: null })),
      review: vi.fn(unavailable), reviewBinding: vi.fn(unavailable), readFile: vi.fn(unavailable) }, proposalGateway: { latest: vi.fn(async () => null),
        publish: vi.fn(unavailable), review: vi.fn(unavailable), readFile: vi.fn(unavailable), reject: vi.fn(unavailable) } },
  };
  const releaseQueue = gateways.queue.registry.retain(), releaseSteering = gateways.steering.registry.retain(), releaseHandoff = handoffRegistry.retain();
  return { gateways, queueGateway, send, release: () => { releaseQueue(); releaseSteering(); releaseHandoff(); } };
}
let root: Root, host: HTMLDivElement, files: WritingFileSessions;
let adapters: ReturnType<typeof fixture>[];
let originalLocks: PropertyDescriptor | undefined;
function isolatedStorage(): Storage {
  const values = new Map<string, string>();
  return {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {values.set(key, value);}, removeItem: key => {values.delete(key);}, clear: () => values.clear()};
}
beforeEach(() => {
  vi.clearAllMocks(); resetWritingSubmissionControllersForTests(); resetWritingRetrievalOwnersForTests();
  selectAppStorage(isolatedStorage());
  files = new WritingFileSessions();
  files.open({ manuscriptId, relativePath: "main.tex" }, "original", "a".repeat(64)).applyAgent("earlier", 0, "latest proposal");
  files.open({ manuscriptId, relativePath: "other.tex" }, "other", "b".repeat(64)).dispatch({ changes: { from: 0, insert: "unsaved " }, userEvent: "input.type" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); adapters = [];
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks); else delete (navigator as {locks?:unknown}).locks;
  originalLocks = undefined;
  for (const adapter of adapters) adapter.release();
  expect(invoke).not.toHaveBeenCalled(); resetWritingSubmissionControllersForTests(); resetWritingRetrievalOwnersForTests();
});
const admitted = vi.fn();
interface DraftHarness {readonly persistence: ConversationDraftPersistence; readonly capture: (store: ConversationDraftPort) => void}
function DraftStoreProbe({capture}: Pick<DraftHarness, "capture">) {
  const store = useAgentDraftStore(); useEffect(() => capture(store), [capture, store]); return null;
}
function Harness({ gateways, conversationId = conversationA, visible = true, running = false, drafts }: {
  readonly gateways: WritingAgentRuntimeGateways; readonly conversationId?: string; readonly visible?: boolean; readonly running?: boolean;
  readonly drafts?: DraftHarness;
}) {
  const projection = { ...createAgentConversationProjection(conversationId), activeTurn: running ? turnId : null };
  const main=files.get({manuscriptId,relativePath:"main.tex"})!;
  return <AgentDraftProvider {...(drafts ? {persistence: drafts.persistence} : {})}>{drafts && <DraftStoreProbe capture={drafts.capture}/>}<AgentQueueProvider><AgentSteeringProvider>{visible && <WritingAgentRuntimePanel
    gateways={gateways} manuscriptId={manuscriptId} conversationId={conversationId} conversationTitle="Mock paper"
    activePath="main.tex" content={main.read().content} contentHash={main.savedSha256}
    readEditorSnapshot={()=>captureWritingEditor(main.state,`${manuscriptId}:main.tex`)} files={["main.tex", "other.tex"].map(path => ({
      manuscriptId, relativePath: parseManuscriptPath(path), kind: "tex", sha256: "old metadata", sizeBytes: 0, modifiedAt: "now",
    }))} readFileBuffers={() => files.readBuffers(manuscriptId)} messages={[]} projection={projection} historyReady open
    onOpenChange={() => undefined} onSubmissionAdmitted={admitted} onOpenConversation={() => undefined} />}</AgentSteeringProvider></AgentQueueProvider></AgentDraftProvider>;
}
async function render(gateways: WritingAgentRuntimeGateways, options: { conversationId?: string; visible?: boolean; running?: boolean; drafts?: DraftHarness } = {}) {
  await act(async () => root.render(<Harness gateways={gateways} {...options} />));
  if (options.visible !== false) await vi.waitFor(() => expect(host.querySelector('[aria-label="队列引导核对"]')).toBeNull());
}
async function type(text: string) {
  const input = host.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
async function retryNotice() {
  const options = [...vi.mocked(notify.error).mock.calls].reverse().find(call => call[1]?.actions || call[1]?.action)?.[1];
  const action = options?.actions?.find(action => action.id === "secondary") ?? options?.action;
  expect(action && typeof action==="object" && "onClick" in action).toBe(true);
  if(action && typeof action==="object" && "onClick" in action && typeof action.onClick==="function")
    await act(async()=>{(action.onClick as ()=>void)();});
}
function adapter() { const value = fixture(); adapters.push(value); return value; }

it("blocks sending when the writing environment has no matching handoff owner", async () => {
  const value = adapter();
  const {steeringHandoff: _handoff, ...withoutHandoff} = value.gateways;
  await act(async () => root.render(<Harness gateways={withoutHandoff}/>));
  await type("Keep this draft");
  expect(host.textContent).toContain("暂时无法检查引导状态。");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(true);
  await submit();
  expect(value.gateways.submission.prepareWriting).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")!.value).toBe("Keep this draft");
});

it("shows context recovery in the writing host and reconnects the original configuration", async () => {
  originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", {configurable:true, value:{request:async (name:string, _options:unknown, callback:(lock:object|null)=>Promise<unknown>) => {
    if (held.has(name)) return callback(null); held.add(name); try {return await callback({});} finally {held.delete(name);}
  }}});
  const value = adapter();
  const rows = new Map([[conversationA,{revision:1,state:EMPTY_AGENT_CONTEXT}]]);
  const authority = await createMockContextConfigurationAuthority(getAppStorage(), rows);
  let failing = true;
  const configurationSave = {...authority.configurationSave, environment:async (...args:Parameters<typeof authority.configurationSave.environment>) => {
    if (failing) throw new Error("synthetic context failure"); return authority.configurationSave.environment(...args);
  }};
  const context = {...value.gateways.context!, ...authority, configurationSave};
  await render({...value.gateways, context});
  await vi.waitFor(() => expect(host.textContent).toContain("上下文暂时无法恢复"));
  expect(host.querySelector('[aria-label="上下文配置恢复"]')).not.toBeNull();
  expect(value.gateways.submission.prepareWriting).not.toHaveBeenCalled();
  failing = false;
  const retry = [...host.querySelectorAll("button")].find(button=>button.textContent==="核对并重试");
  expect(retry).toBeDefined(); await act(async()=>retry!.click());
  await vi.waitFor(() => expect(host.querySelector('[aria-label="上下文配置恢复"]')).toBeNull());
});

it("retains writing start and recommendation when accepted context save loses its reply", async () => {
  originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", {configurable:true, value:{request:async (name:string, _options:unknown, callback:(lock:object|null)=>Promise<unknown>) => {
    if (held.has(name)) return callback(null); held.add(name); try {return await callback({});} finally {held.delete(name);}
  }}});
  const value = adapter(), storage = getAppStorage();
  const rows = new Map([[conversationA,{revision:1,state:EMPTY_AGENT_CONTEXT}]]);
  const authority = await createMockContextConfigurationAuthority(storage, rows);
  const save=vi.fn(async (...args:Parameters<typeof authority.configurationSave.save>)=>{
    if(save.mock.calls.length===1) {await authority.configurationSave.save(...args); throw new Error("lost response");}
    return authority.configurationSave.save(...args);
  });
  const item={label:"Synthetic note",resource:{kind:"note",resourceId:"55555555-5555-4555-8555-555555555555"}};
  storage.setItem(recommendationDraftKey(conversationA),JSON.stringify([{item,selected:true}]));
  const context={...value.gateways.context!,...authority,configurationSave:{...authority.configurationSave,save}};
  await render({...value.gateways,context}); await type("Original question"); await submit();
  await vi.waitFor(()=>expect(host.textContent).toContain("上下文保存结果尚未确认"));
  const locator=`research-assistant:writing-prepare:v1:${manuscriptId}:${conversationA}`;
  expect(storage.getItem(locator)).not.toBeNull(); expect(storage.getItem(recommendationSubmissionKey(conversationA))).not.toBeNull();
  expect(value.gateways.submission.startWriting).toHaveBeenCalledOnce();
  const retry=[...host.querySelectorAll("button")].find(button=>button.textContent==="核对并重试");
  expect(retry).toBeDefined(); await act(async()=>retry!.click());
  await retryNotice();
  await vi.waitFor(()=>expect(storage.getItem(locator)).toBeNull());
  expect(rows.get(conversationA)?.state.persistent).toEqual([item]);
  expect(storage.getItem(recommendationSubmissionKey(conversationA))).toBeNull();
  expect(value.gateways.submission.startWriting).toHaveBeenCalledOnce();
});

async function pausedQueueAdapter() {
  const value = adapter();
  const queue = new WritingDiffDemoQueue(value.gateways.submission);
  const scope = { manuscriptId, conversationId: conversationA };
  let revision = 0;
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, inputId] of ids.entries()) {
    revision = (await queue.gateway.edit({ ...scope, requestId: crypto.randomUUID(), expectedRevision: revision,
      edit: { type: "add", inputId, text: `Queued ${index + 1}`, userInput: [{ type: "text", text: `Queued ${index + 1}`, textElements: [] }] } })).revision;
  }
  await queue.gateway.edit({ ...scope, requestId: crypto.randomUUID(), expectedRevision: revision, edit: { type: "pause" } });
  const registry = new AgentInputQueueRegistry(queue.gateway, scope => JSON.stringify([scope.manuscriptId, scope.conversationId]), () => crypto.randomUUID());
  const release = registry.retain();
  const originalRelease = value.release;
  value.release = () => { release(); originalRelease(); };
  const gateways = { ...value.gateways, queue: { gateway: queue.gateway, registry }, queuePreview: queue.preview };
  return { ...value, gateways, queue, scope, ids };
}

it("keeps Steer available after stopping and starts the selected item exactly once without clearing the next draft", async () => {
  const value = await pausedQueueAdapter();
  await render(value.gateways, { running: true });
  expect(host.querySelector('button[aria-label="将第 2 条消息插入当前轮次"]')).not.toBeNull();
  await render(value.gateways, { running: false });
  await type("Unsent draft stays here");
  const steer = host.querySelector<HTMLButtonElement>('button[aria-label="用第 2 条消息启动新轮次"]')!;
  expect(steer.disabled).toBe(false);
  await act(async () => { steer.click(); steer.click(); });
  expect(value.gateways.submission.startWriting).toHaveBeenCalledOnce();
  expect(value.gateways.submission.prepareWriting).toHaveBeenCalledWith(expect.objectContaining({ text: "Queued 2",
    userInput: [{ type: "text", text: "Queued 2", textElements: [] }] }));
  expect(value.send).not.toHaveBeenCalled();
  const remaining = await value.queue.gateway.read(value.scope);
  expect(remaining.inputs.map(input => input.inputId)).toEqual([value.ids[0], value.ids[2]]);
  expect(remaining.paused).toBe(false);
  expect(host.querySelector('textarea')?.value).toBe("Unsent draft stays here");
  expect(host.querySelector('button[aria-label="将第 1 条消息插入当前轮次"]')).not.toBeNull();
});

it("retains the selected queue item through an uncertain start and consumes it only after retrying the same request", async () => {
  const value = await pausedQueueAdapter();
  value.queue.failNextStart("beforeAdmission"); const start = vi.spyOn(value.queue.preview, "start");
  await render(value.gateways);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="用第 2 条消息启动新轮次"]')!.click());
  expect((await value.queue.gateway.read(value.scope)).inputs.map(input => input.inputId)).toEqual([value.ids[1], value.ids[0], value.ids[2]]);
  const original = start.mock.calls[0]![0]; expect(value.gateways.submission.startWriting).not.toHaveBeenCalled();
  await retryNotice();
  expect(value.gateways.submission.prepareWriting).toHaveBeenCalledOnce();
  expect(start.mock.calls.map(([request]) => request)).toEqual([original, original]);
  expect(value.gateways.submission.startWriting).toHaveBeenCalledExactlyOnceWith(original.start);
  expect((await value.queue.gateway.read(value.scope)).inputs.map(input => input.inputId)).toEqual([value.ids[0], value.ids[2]]);
});

it("keeps the queue paused and the message intact if source capture fails before preparing the explicit Steer", async () => {
  const value = await pausedQueueAdapter();
  await render(value.gateways);
  const read = vi.spyOn(files, "readBuffers").mockImplementation(() => { throw new Error("Source unavailable"); });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="用第 2 条消息启动新轮次"]')!.click());
  const retained = await value.queue.gateway.read(value.scope);
  expect(retained.paused).toBe(true);
  expect(retained.inputs.map(input => input.inputId)).toEqual([value.ids[1], value.ids[0], value.ids[2]]);
  expect(value.gateways.submission.prepareWriting).not.toHaveBeenCalled();
  expect(value.gateways.submission.startWriting).not.toHaveBeenCalled();
  read.mockRestore();
});

it("allows a new message using current file buffers without a chat-wide file-delivery lock", async () => {
  const { gateways } = adapter();
  const main = files.get({ manuscriptId, relativePath: "main.tex" })!;
  main.applyAgent("partial-delivery", main.read().version, "current partial delivery text");
  await render(gateways, { conversationId: conversationB });
  await type("Explain the file error");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(false);
  expect(host.querySelector("textarea")!.value).toBe("Explain the file error");
});

it("uses injected production submission, workspace, model, history and queue I/O with the latest file buffers in both conversations", async () => {
  const { gateways } = adapter();
  await render(gateways); await type("Continue from latest text"); await submit();
  expect(gateways.model.getLlmConfiguration).toHaveBeenCalled(); expect(gateways.model.fetchLlmProviderModels).toHaveBeenCalled();
  expect(gateways.forkOrigin.read).toHaveBeenCalled(); expect(gateways.subtasks.list).toHaveBeenCalledWith(conversationA);
  // No completed turn exists yet: do not fetch a latest card for this reply.
  expect(gateways.review.workspaceReviewGateway!.list).not.toHaveBeenCalled();
  expect(gateways.submission.prepareWriting).toHaveBeenCalledWith(expect.objectContaining({ conversationId: conversationA,
    context: { manuscriptId, files: [expect.objectContaining({ relativePath: "main.tex", buffer: expect.objectContaining({ text: "latest proposal" }) })] } }));
  expect(gateways.workspace.prepare).toHaveBeenCalledWith(expect.objectContaining({ buffers: files.readBuffers(manuscriptId) }));
  const main = files.get({ manuscriptId, relativePath: "main.tex" })!;
  main.resolveAll("keep"); main.dispatch({ changes: { from: main.state.doc.length, insert: " manual" }, userEvent: "input.type" });
  await render(gateways, { conversationId: conversationB }); await type("Continue in another chat"); await submit();
  expect(gateways.submission.prepareWriting).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: conversationB,
    context: { manuscriptId, files: [expect.objectContaining({ buffer: expect.objectContaining({ text: "latest proposal manual" }) })] } }));
  expect(main.read().reviewBaseline).toBe("latest proposal manual"); expect(admitted).toHaveBeenCalledTimes(2);
});

it("omits empty submission controls while running and retains stop failure feedback", async () => {
  const { gateways } = adapter();
  await render(gateways); await type("Start a turn"); await submit();
  expect(gateways.submission.startWriting).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="写作提交状态"]')).toBeNull();
  vi.mocked(gateways.turns.interrupt).mockRejectedValueOnce(new Error("Stop unavailable"));
  const stop = host.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')!;
  await act(async () => stop.click());
  expect(host.querySelector('[aria-label="发送恢复"]')).toBeNull();
  expect(notify.error).toHaveBeenCalledWith("停止请求失败，请重试。",expect.objectContaining({action:expect.any(Object)}));
});

it("keeps a failed workspace copy recoverable and explicitly continues the same preparation", async () => {
  const { gateways } = adapter();
  vi.mocked(gateways.workspace.prepare).mockRejectedValueOnce(new Error("Copy unavailable"));
  await render(gateways); await type("Keep the frozen request"); await submit();
  expect(host.querySelector('[aria-label="写作提交状态"]')).toBeNull();
  expect(host.querySelector('[aria-label="发送恢复"]')).toBeNull();
  expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("无法准备可编辑副本"), expect.objectContaining({dismissible: false,
    actions: [expect.objectContaining({label: "重新发送"}), expect.objectContaining({label: "返回编辑"})]}));
  expect(host.textContent).not.toContain("latest proposal");
  expect(gateways.submission.startWriting).not.toHaveBeenCalled();
  const original = vi.mocked(gateways.submission.prepareWriting).mock.calls[0]![0];
  vi.mocked(gateways.workspace.restore).mockRejectedValueOnce("notFound");
  const options = vi.mocked(notify.error).mock.calls.at(-1)?.[1];
  await act(async () => options?.actions?.find(action => action.label === "重新发送")!.onClick());
  expect(gateways.submission.prepareWriting).toHaveBeenCalledOnce();
  expect(gateways.workspace.prepare).toHaveBeenCalledTimes(2);
  expect(gateways.submission.startWriting).toHaveBeenCalledOnce();
  expect(gateways.submission.startWriting).toHaveBeenCalledWith(expect.objectContaining({requestId: original.requestId}));
  expect(host.querySelector('[aria-label="发送恢复"]')).toBeNull();
});

it("keeps an admitted start attached to its original backend when the same conversation IDs open in another mock storage", async () => {
  const firstStorage = getAppStorage(), first = adapter();
  let finish!: (response: AgentWritingStartResponse) => void;
  vi.mocked(first.gateways.submission.startWriting).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(first.gateways); await type("First storage");
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(first.gateways.submission.startWriting).toHaveBeenCalledOnce();
  const receiptKey = `research-assistant:writing-prepare:v1:${manuscriptId}:${conversationA}`;
  const originalReceipt = firstStorage.getItem(receiptKey);
  expect(originalReceipt).not.toBeNull();
  const secondStorage = isolatedStorage(); selectAppStorage(secondStorage); const second = adapter();
  await render(second.gateways); await type("Second storage"); await submit();
  expect(second.gateways.submission.prepareWriting).toHaveBeenCalledWith(expect.objectContaining({ text: "Second storage" }));
  expect(firstStorage.getItem(receiptKey)).toBe(originalReceipt);
  expect(secondStorage.getItem(receiptKey)).toBeNull();
  const request = vi.mocked(first.gateways.submission.startWriting).mock.calls[0]![0];
  await act(async () => finish({ schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId,
    turnId, alreadyStarted: false, outcome: null }));
  expect(admitted).toHaveBeenCalledTimes(1);
  expect(firstStorage.getItem(receiptKey)).not.toBeNull();
  selectAppStorage(firstStorage); await render(first.gateways);
  await retryNotice();
  await vi.waitFor(()=>expect(firstStorage.getItem(receiptKey)).toBeNull());
  expect(admitted).toHaveBeenCalledTimes(2);
  expect(vi.mocked(first.gateways.submission.prepareWriting).mock.calls[0]![0].text).toBe("First storage");
});

it("retains an uncertain injected queue operation across view removal and retries its original receipt", async () => {
  const value = adapter();
  value.queueGateway.edit.mockRejectedValue(new Error("Lost queue reply"));
  await render(value.gateways, { running: true }); await type("Keep original queue message");
  await submit();
  const original = structuredClone(value.queueGateway.edit.mock.calls[0]![0]);
  if (original.edit.type !== "add") throw new Error("Expected queued add");
  await render(value.gateways, { visible: false }); await render(value.gateways, { running: true });
  await vi.waitFor(async () => { await act(async () => Promise.resolve()); expect(host.querySelector('[aria-label="重试队列同步"]')).not.toBeNull(); }, { timeout: 2500 });
  expect(host.textContent).toContain("队列暂时无法同步");
  value.queueGateway.edit.mockResolvedValueOnce({ schemaVersion: 1, manuscriptId, conversationId: conversationA,
    revision: original.expectedRevision + 1, paused: true, preparingInputId: null, inputs: [{ inputId: original.edit.inputId, text: original.edit.text }] });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="重试队列同步"]')!.click());
  expect(value.queueGateway.edit).toHaveBeenNthCalledWith(4, original);
  expect(host.querySelector("textarea")!.value).toBe("");
});

it("retains injected same-turn steering across view removal and clears only the acknowledged draft", async () => {
  const value = adapter(); value.send.mockRejectedValueOnce(new Error("Lost steer reply"));
  await render(value.gateways, { running: true }); await type("Keep original steering message");
  await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
  const original = structuredClone(value.send.mock.calls[0]![0]);
  await render(value.gateways, { visible: false }); await render(value.gateways, { running: true });
  expect(host.textContent).toContain("接收结果未确认");
  value.send.mockResolvedValueOnce({ schemaVersion: 1, conversationId: conversationA, turnId, inputId: original.inputId });
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "重试原补充说明")!.click());
  expect(value.send).toHaveBeenNthCalledWith(2, original); expect(host.querySelector("textarea")!.value).toBe("");
});

it("keeps a pending retrieval preview in its original storage instead of attaching it to equal conversation IDs elsewhere", async () => {
  const first = adapter(), second = adapter();
  const preview = { traceId: "mock-trace", semanticStatus: "used" as const, seeds: [], edges: [], sources: [],
    selectedSourceCount: 0, externalPaperCount: 0, contextSha256: "a".repeat(64), expiresAt: "later" };
  let finish!: (value: typeof preview) => void;
  vi.mocked(first.gateways.retrieval.previewConceptRetrieval).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(first.gateways); await type("Retrieve original sources");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="添加上下文和工具"]')!.click());
  await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="概念网络检索"]')!.click());
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(first.gateways.retrieval.previewConceptRetrieval).toHaveBeenCalledOnce();
  await render(second.gateways); await act(async () => finish(preview));
  expect(host.textContent).not.toContain("确认来源并发送");
  await render(first.gateways);
  expect(host.textContent).toContain("确认来源并发送");
  expect(first.gateways.submission.prepareWriting).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "确认来源并发送")!.click());
  expect(first.gateways.submission.prepareWriting).toHaveBeenCalledWith(expect.objectContaining({ retrieval: { traceId: "mock-trace", query: "Retrieve original sources" } }));
  expect(second.gateways.submission.prepareWriting).not.toHaveBeenCalled();
});

it.each(["unchanged", "same text", "references"] as const)("signs only the original draft after a delayed retrieval and start ACK (%s)", async change => {
  const {gateways} = adapter(), persistence = localConversationDraftPersistence(getAppStorage());
  let store!: ConversationDraftPort;
  const drafts = {persistence, capture: (value: ConversationDraftPort) => {store = value;}};
  const scope = {hostKind: "manuscript" as const, hostId: manuscriptId, conversationId: conversationA}, key = conversationDraftKey(scope);
  const reference: AgentReferenceInput = {type: "mention", name: "source", target: {kind: "file", sourceId: "manuscript", resourceId: "main.tex"}};
  const preview = {traceId: crypto.randomUUID(), semanticStatus: "used" as const, seeds: [], edges: [], sources: [],
    selectedSourceCount: 0, externalPaperCount: 0, contextSha256: "a".repeat(64), expiresAt: "later"};
  let resolvePreview!: (value: typeof preview) => void, resolveStart!: (value: AgentWritingStartResponse) => void;
  vi.mocked(gateways.retrieval.previewConceptRetrieval).mockImplementation(() => new Promise(resolve => {resolvePreview = resolve;}));
  vi.mocked(gateways.submission.startWriting).mockImplementation(() => new Promise(resolve => {resolveStart = resolve;}));
  await render(gateways, {drafts});
  if (change !== "references") await type("Find related work");
  else await act(async () => store.updateStructured(key, insertAgentReference({text: "Find related work ", bindings: []}, reference)));
  const originalDraft = structuredClone(store.readStructured(key)), originalRevision = persistence.load().get(key)!.revision;
  const originalWire = serializeAgentSourceReferences(originalDraft, {kind: "manuscript", resourceId: manuscriptId, conversationId: conversationA});
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="添加上下文和工具"]')!.click());
  await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="概念网络检索"]')!.click());
  await submit();
  expect(gateways.retrieval.previewConceptRetrieval).toHaveBeenCalledExactlyOnceWith({clientRequestId: expect.any(String), query: originalWire.text});
  expect(gateways.submission.prepareWriting).not.toHaveBeenCalled();
  if (change === "same text") {
    expect(host.querySelector("textarea")!.disabled).toBe(true);
    // Another owner can replace the draft while this composer's retrieval is locked.
    await act(async () => { store.update(key, ""); store.update(key, originalDraft.text); });
  } else if (change === "references") {
    expect(host.querySelector('.cm-content[contenteditable="false"]')).not.toBeNull();
    await act(async () => store.updateStructured(key, {...originalDraft, bindings: originalDraft.bindings.map(binding => ({...binding,
      input: {type: "mention", name: "source", target: {kind: "file", sourceId: "manuscript", resourceId: "other.tex"}}}))}));
  }
  const replacement = structuredClone(store.readStructured(key)), replacementRevision = persistence.load().get(key)!.revision;
  expect(replacement.text).toBe(originalDraft.text);
  if (change === "unchanged") expect(replacementRevision).toBe(originalRevision); else expect(replacementRevision).not.toBe(originalRevision);
  await act(async () => resolvePreview(preview));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "确认来源并发送")!.click());
  await vi.waitFor(() => expect(gateways.submission.startWriting).toHaveBeenCalledOnce());
  expect(gateways.submission.prepareWriting).toHaveBeenCalledWith(expect.objectContaining({text: originalWire.text, userInput: originalWire.userInput,
    retrieval: {traceId: preview.traceId, query: originalWire.text}, context: {manuscriptId, files: [expect.objectContaining({relativePath: "main.tex"})]}}));
  expect(store.readStructured(key)).toEqual(replacement);
  const start = vi.mocked(gateways.submission.startWriting).mock.calls[0]![0];
  await act(async () => resolveStart({schemaVersion: 1, conversationId: start.conversationId, requestId: start.requestId, turnId, alreadyStarted: false, outcome: null}));
  expect(gateways.submission.prepareWriting).toHaveBeenCalledOnce(); expect(gateways.submission.startWriting).toHaveBeenCalledOnce();
  if (change === "unchanged") {
    expect(host.querySelector("textarea")!.value).toBe(""); expect(store.read(key)).toBe("");
    expect(persistence.load().has(key)).toBe(false); expect(new ConversationDraftStore(persistence).read(key)).toBe(""); return;
  }
  if (change === "same text") expect(host.querySelector("textarea")!.value).toBe(replacement.text);
  else expect(host.querySelector(".cm-content")).not.toBeNull();
  expect(store.readStructured(key)).toEqual(replacement);
  expect(persistence.load().get(key)).toMatchObject({revision: replacementRevision, draft: replacement});
  expect(new ConversationDraftStore(persistence).readStructured(key)).toEqual(replacement);
});

it.each(["explicit", "automatic"] as const)("%s queue dispatch does not capture a same-text composer draft receipt", async dispatch => {
  const value = await pausedQueueAdapter(), persistence = localConversationDraftPersistence(getAppStorage());
  let store!: ConversationDraftPort, resolveStart!: (result: AgentWritingStartResponse) => void;
  const drafts = {persistence, capture: (next: ConversationDraftPort) => {store = next;}};
  const key = conversationDraftKey({hostKind: "manuscript", hostId: manuscriptId, conversationId: conversationA});
  const selected = dispatch === "explicit" ? 1 : 0, text = `Queued ${selected + 1}`;
  vi.mocked(value.gateways.submission.startWriting).mockImplementation(() => new Promise(resolve => {resolveStart = resolve;}));
  await render(value.gateways, {drafts, running: true}); await type(text);
  const original = structuredClone(store.readStructured(key)), revision = persistence.load().get(key)!.revision;
  if (dispatch === "explicit") {
    await render(value.gateways, {drafts});
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="用第 2 条消息启动新轮次"]')!.click());
  } else {
    const queue = await value.queue.gateway.read(value.scope);
    await value.queue.gateway.edit({...value.scope, requestId: crypto.randomUUID(), expectedRevision: queue.revision, edit: {type: "resume"}});
    await render(value.gateways, {drafts});
  }
  await vi.waitFor(() => expect(value.gateways.submission.startWriting).toHaveBeenCalledOnce());
  const receipt = JSON.parse(getAppStorage().getItem(`research-assistant:writing-queue-start:v1:${manuscriptId}:${conversationA}`)!);
  expect(receipt.intent.inputId).toBe(value.ids[selected]); expect(receipt.draftAcknowledgment).toBeNull();
  expect(value.gateways.submission.prepareWriting).toHaveBeenCalledWith(expect.objectContaining({text}));
  expect(store.readStructured(key)).toEqual(original);
  const start = vi.mocked(value.gateways.submission.startWriting).mock.calls[0]![0];
  await act(async () => resolveStart({schemaVersion: 1, conversationId: start.conversationId, requestId: start.requestId, turnId, alreadyStarted: false, outcome: null}));
  expect(host.querySelector("textarea")!.value).toBe(text); expect(store.readStructured(key)).toEqual(original);
  expect(persistence.load().get(key)).toMatchObject({revision, draft: original});
  expect(new ConversationDraftStore(persistence).readStructured(key)).toEqual(original);
  expect(value.gateways.submission.startWriting).toHaveBeenCalledOnce();
  expect((await value.queue.gateway.read(value.scope)).inputs.map(input => input.inputId)).not.toContain(value.ids[selected]);
});
