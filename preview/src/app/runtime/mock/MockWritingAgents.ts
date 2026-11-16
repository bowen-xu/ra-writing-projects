import { writeAgentSessionSelection } from "@research-assistant/workbench-preview/agent-session-selection";
import { decodeAgentCreateBoundRequest, decodeAgentRenameRequest, decodeAgentArchiveRequest, decodeAgentDeletionRequest, decodeAgentDeletionWriteOptions, type AgentConversationBinding } from "@research-assistant/core/agent";
import type { AppGateways } from "@research-assistant/workbench-preview/app-gateway-types";
import type { PreviewControls } from "@research-assistant/workbench-preview/app-runtime";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import type { WritingCheckpointGateway } from "../../../../../src/public/writingCheckpointGateway.ts";
import { WritingDiffDemoAgentStorage } from "../../previews/agent/WritingDiffDemoAgentStorage";
import { createWritingDiffDemoRuntime } from "../../previews/agent/writingDiffDemoRuntime";
import { initialChanges } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";
import { monitorMockGateway } from "./mockOperations";
import { MockWritingDisk } from "./MockWritingDisk";
import { MockBoundCatalogReceipts } from "./MockBoundCatalogReceipts";
import type { AgentDeletionRequest } from "@research-assistant/core/agent";
import type { MockConversationDeletionPlan } from "@research-assistant/workbench-preview/mock-conversation-deletion-batch";
import type {AgentSteeringHandoffGateway} from "@research-assistant/data/agent";

interface Backend {
  agent: WritingDiffDemoAgentStorage;
  runtime: ReturnType<typeof createWritingDiffDemoRuntime>;
  conversationId: string;
}
function createBackend(manuscriptId: string, conversationId: string, disk: MockWritingDisk, checkpoints: WritingCheckpointGateway, kind: AgentConversationBinding["kind"] = "manuscript"): Backend {
  const agent = new WritingDiffDemoAgentStorage({ files: disk.files, checkpoints }, undefined);
  const runtime = createWritingDiffDemoRuntime({ files: disk.files, checkpoints }, agent, manuscriptId, conversationId, kind);
  return { agent, runtime, conversationId };
}
interface Snapshot {
  readonly submissions?: ReturnType<Backend["runtime"]["execution"]["snapshot"]>;
  readonly compaction?: ReturnType<Backend["runtime"]["compaction"]["snapshot"]>;
  readonly kind?: AgentConversationBinding["kind"];
  readonly conversationId: string;
  readonly agent: ReturnType<Backend["agent"]["snapshot"]>;
  readonly history: ReturnType<Backend["agent"]["history"]["snapshot"]>;
  readonly undos: ReturnType<Backend["agent"]["undoStorage"]["snapshot"]>;
  readonly restorations: ReturnType<Backend["agent"]["restorationStorage"]["snapshot"]>;
  readonly conversations: ReturnType<Backend["runtime"]["conversations"]["snapshot"]>;
  readonly queue: ReturnType<Backend["runtime"]["queue"]["snapshot"]>;
}
/** File/Agent state has an app lifetime. Canvas visibility never selects data. */
export class MockWritingAgents {
  private disposed = false;
  contextSources?: (resources:readonly import("@research-assistant/core/agent").AgentContextResource[],primaryManuscriptId?:string)=>Promise<readonly import("@research-assistant/core/agent").AgentContextText[]>;
  private readonly backends = new Map<string, Backend>();
  private readonly conversations: Map<string, string>;
  private readonly disk: MockWritingDisk;
  private readonly receipts: MockBoundCatalogReceipts;
  unboundConversationExists: (id: string) => boolean = () => false;
  foreignOperationExists: (id: string) => boolean = () => false;
  hasOperation(id: string): boolean { return this.receipts.owner(id) !== undefined; }
  constructor(private readonly storage: Storage, private readonly writing: WritingGateway,
    private readonly checkpoints: WritingCheckpointGateway, private readonly controls: PreviewControls,
    private readonly resourceAvailable: (binding: AgentConversationBinding) => Promise<boolean> = async binding =>
      binding.kind === "manuscript" && (await writing.listManuscripts()).some(row => row.id === binding.resourceId)) {
    this.conversations = new Map(JSON.parse(storage.getItem("agent-bindings") ?? "[]") as [string, string][]);
    this.disk = new MockWritingDisk(writing, storage);
    this.receipts = new MockBoundCatalogReceipts(storage, id => this.foreignOperationExists(id));
  }
  private persist(manuscriptId: string, backend: Backend): void {
    if (this.disposed) return;
    for (const [id] of backend.runtime.conversations.snapshot().records) this.conversations.set(id, manuscriptId);
    const snapshot: Snapshot = { submissions: backend.runtime.execution.snapshot(), compaction: backend.runtime.compaction.snapshot(), kind: backend.runtime.bindingKind, conversationId: backend.conversationId, agent: backend.agent.snapshot(), history: backend.agent.history.snapshot(), undos: backend.agent.undoStorage.snapshot(), restorations: backend.agent.restorationStorage.snapshot(), conversations: backend.runtime.conversations.snapshot(), queue: backend.runtime.queue.snapshot() };
    this.storage.setItem(`agent:${manuscriptId}`, encodeMockState(snapshot));
    this.receipts.record(manuscriptId, {renames: snapshot.conversations.renames, creations: snapshot.conversations.creations, archiveReceipts: snapshot.conversations.archiveReceipts, forkReceipts: snapshot.conversations.forkReceipts, deletionReceipts: snapshot.conversations.deletionReceipts, deletedRequests: snapshot.conversations.deletedRequests});
    this.storage.setItem("agent-bindings", JSON.stringify([...this.conversations]));
  }
  backend(manuscriptId: string, kind: AgentConversationBinding["kind"] = "manuscript"): Backend {
    const current = this.backends.get(manuscriptId); if (current) return current;
    const raw = this.storage.getItem(`agent:${manuscriptId}`), saved = raw ? decodeMockState<Snapshot>(raw) : null;
    const backend = createBackend(manuscriptId, saved?.conversationId ?? crypto.randomUUID(), this.disk, this.checkpoints, saved?.kind ?? kind);
    backend.runtime.conversations.foreignOperationExists = id => {
      const owner = this.receipts.owner(id);
      return this.foreignOperationExists(id) || owner !== undefined && owner !== manuscriptId;
    };
    backend.runtime.execution.contextSources=this.contextSources;
    this.backends.set(manuscriptId, backend);
    if (saved) {
      if (saved.submissions) backend.runtime.execution.restore(saved.submissions);
      backend.agent.restore(saved.agent); backend.agent.history.restore(saved.history);
      backend.agent.undoStorage.restore(saved.undos); backend.agent.restorationStorage.restore(saved.restorations);
      backend.runtime.conversations.restore(saved.conversations); backend.runtime.queue.restore(saved.queue);
      if (saved.compaction) backend.runtime.compaction.restore(saved.compaction);
      backend.agent.history.interruptUnfinished(); backend.agent.recoverOnStartup();
    }
    backend.runtime.execution.reschedule(900);
    backend.runtime.execution.progressiveFeedback = true;
    backend.agent.history.onChange = () => queueMicrotask(() => this.persist(manuscriptId, backend));
    this.persist(manuscriptId, backend);
    return backend;
  }
  async initialize(): Promise<void> {
    const manuscripts = await this.writing.listManuscripts();
    for (const manuscript of manuscripts) this.backend(manuscript.id);
    const id = this.storage.getItem("initial-manuscript");
    if (!id || this.storage.getItem("agent-seeded") === "1"
      || !manuscripts.some(manuscript => manuscript.id === id && manuscript.status === "active")) return;
    const backend = this.backend(id);
    await backend.agent.complete({ scope: { manuscriptId: id, conversationId: backend.conversationId, requestId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID() }, turnId: crypto.randomUUID() }, initialChanges);
    writeAgentSessionSelection({ kind: "manuscript", resourceId: id }, backend.conversationId);
    this.persist(id, backend); this.storage.setItem("agent-seeded", "1");
  }
  private async select(args: readonly unknown[]): Promise<{ id: string; backend: Backend }> {
    function identity(value: unknown): { manuscriptId?: string | undefined; conversationId?: string | undefined } {
      if (typeof value === "string") return { conversationId: value };
      if (!value || typeof value !== "object") return {};
      const row = value as Record<string, unknown>;
      if (typeof row.manuscriptId === "string") return { manuscriptId: row.manuscriptId };
      if (["manuscript", "note", "paper", "readingNote"].includes(String(row.kind)) && typeof row.resourceId === "string") return { manuscriptId: row.resourceId };
      for (const field of ["binding", "scope", "proposal", "parent", "request", "submission", "context", "host"]) { const found = identity(row[field]); if (found.manuscriptId) return found; }
      return { conversationId: typeof row.conversationId === "string" ? row.conversationId : typeof row.id === "string" ? row.id : typeof row.parentId === "string" ? row.parentId : undefined };
    }
    const found = identity(args[0]);
    const id = found.manuscriptId ?? (found.conversationId ? this.conversations.get(found.conversationId) : undefined) ?? (await this.writing.listManuscripts())[0]?.id;
    if (!id) throw new Error("请先创建模拟稿件");
    const binding = args[0] && typeof args[0] === "object" ? (args[0] as { binding?: AgentConversationBinding }).binding : undefined;
    return { id, backend: this.backend(id, binding?.kind) };
  }
  private route<T extends object>(select: (backend: Backend) => T): T {
    return new Proxy({} as T, { get: (_target, property) => async (...args: unknown[]) => {
      const { id, backend } = await this.select(args);
      const gateway = monitorMockGateway(select(backend), this.controls, () => this.persist(id, backend));
      const method: unknown = Reflect.get(gateway, property);
      if (typeof method !== "function") throw new Error(`预览 Agent 方法未覆盖：${String(property)}`);
      return method.apply(gateway, args);
    } });
  }
  async moveConversation(id:string,directoryId:string|null,independent:import("./MockIndependentAgents").MockIndependentAgents){
    const source=this.conversations.get(id);let data;
    if(independent.has(id))data=await independent.releaseConversation(id);
    else{if(!source)throw "notFound";const backend=this.backend(source);backend.agent.history.assertIdle(id);data={summary:await backend.runtime.conversations.metadata.read({id}),history:backend.agent.history.snapshot()};const records=backend.runtime.conversations.snapshot();records.records.delete(id);records.bindings.delete(id);backend.runtime.conversations.restore(records);this.conversations.delete(id);this.persist(source,backend);}
    if(!directoryId){independent.adoptConversation(id,data);this.storage.setItem("agent-bindings",JSON.stringify([...this.conversations]));return null;}
    const backend=this.backend(directoryId),snapshot=backend.agent.history.snapshot();snapshot.events.set(id,data.history.events.get(id)??[]);for(const [key,value] of data.history.admissions)if(value.scope.conversationId===id)snapshot.admissions.set(key,value);for(const key of data.history.finished)if(snapshot.admissions.get(key)?.scope.conversationId===id)snapshot.finished.add(key);backend.agent.history.restore(snapshot);const records=backend.runtime.conversations.snapshot();records.records.set(id,data.summary);records.bindings.set(id,{kind:"manuscript",resourceId:directoryId});backend.runtime.conversations.restore(records);this.conversations.set(id,directoryId);this.persist(directoryId,backend);return this.contextDirectory(id);
  }
  async listConversations(archived:boolean){return (await Promise.all([...this.backends.values()].map(b=>b.runtime.conversations.catalog.list({archived,limit:500,before:null})))).flatMap(p=>p.conversations);}
  async conversationActivity(){return (await Promise.all([...this.backends.values()].map(b=>b.runtime.conversations.catalog.activity!({})))).flat();}
  async searchConversations(request:import("@research-assistant/core/agent").AgentSearchRequest){return (await Promise.all([...this.backends.values()].map(b=>b.runtime.conversations.search.search(request)))).flatMap(p=>p.hits);}
  async beforeDeletionBatch(): Promise<void> { await this.controls.beforeOperation("agent"); }
  async prepareBatchDeletion(request: AgentDeletionRequest): Promise<MockConversationDeletionPlan> {
    const {id, backend} = await this.select([request]);
    const plan = await backend.runtime.conversations.prepareBatchDeletion(request);
    return {...plan, finish: () => {plan.finish(); this.persist(id, backend);}};
  }
  async contextDirectory(conversationId:string){const id=this.conversations.get(conversationId);if(!id)return null;const backend=this.backend(id);if(backend.runtime.bindingKind!=="manuscript")return null;const manuscript=(await this.writing.listManuscripts()).find(m=>m.id===id);return manuscript?{manuscriptId:id,title:manuscript.title,path:id}:null;}
  private handoffGateway(conversationId:string,options:{readonly persist?:boolean}={}):AgentSteeringHandoffGateway {
    // Handoffs must use the exact conversation's persisted queue and admission
    // journal. Unlike legacy routing, never fall back to the first manuscript.
    const id=this.conversations.get(conversationId);
    if(!id)throw new Error("MOCK_HANDOFF_CONVERSATION_UNAVAILABLE");
    const backend=this.backend(id),gateway=backend.runtime.gateways.context?.steeringHandoff;
    if(!gateway)throw new Error("MOCK_HANDOFF_GATEWAY_UNAVAILABLE");
    return monitorMockGateway(gateway,this.controls,options.persist?()=>this.persist(id,backend):undefined);
  }
  readonly steeringHandoff:AgentSteeringHandoffGateway={
    read:async(id,epoch)=>this.handoffGateway(id).read(id,epoch),
    prepare:async intent=>this.handoffGateway(intent.conversationId,{persist:true}).prepare(intent),
    resolution:async(intent,epoch)=>this.handoffGateway(intent.conversationId).resolution(intent,epoch),
    finish:async(intent,epoch)=>this.handoffGateway(intent.conversationId,{persist:true}).finish(intent,epoch),
    release:async(intent,epoch)=>this.handoffGateway(intent.conversationId,{persist:true}).release(intent,epoch),
    cancelUnregistered:async(intent,epoch)=>this.handoffGateway(intent.conversationId,{persist:true}).cancelUnregistered(intent,epoch),
  };
  async inspectMessage(request: import("@research-assistant/workbench-preview/message-inspection-gateway").MessageInspectionRequest) {
    const { backend } = await this.select([request]);
    return { schemaVersion: 1 as const, ...request, userInput: backend.runtime.execution.inspectUserInput(request), events: backend.agent.history.inspectMessage(request),
      frozenSubmission: request.referencesOnly ? null : backend.runtime.execution.inspectSubmission(request.conversationId, request.turnId) };
  }
  gateways(): Partial<AppGateways> {
    const route = <T extends object>(select: (backend: Backend) => T) => this.route(select);
    const catalog = route(b => b.runtime.conversations.catalog);
    return {
      agentCatalogGateway: {list: catalog.list, activity: request => catalog.activity!(request),
        rename: async input => {
          const request = decodeAgentRenameRequest(input), replay = this.receipts.renameLookup(request);
          return replay ?? catalog.rename(request);
        },
        renameStatus: async input => {
          const request = decodeAgentRenameRequest(input);
          return this.receipts.renameStatus(request, this.conversations.get(request.id));
        }}, agentMetadataGateway: route(b => b.runtime.conversations.metadata),
      agentCreationGateway: {
        createBound: async input => {
          const request = decodeAgentCreateBoundRequest(input);
          await this.controls.beforeOperation("save");
          if (!await this.resourceAvailable(request.binding)) throw "notFound";
          const replay = this.receipts.lookup(request); if (replay) return replay;
          const backend = this.backend(request.binding.resourceId, request.binding.kind);
          await backend.agent.initialized;
          if (!await this.resourceAvailable(request.binding)) throw "notFound";
          // No await splits the final identity check and acceptance.
          const accepted = this.receipts.lookup(request); if (accepted) return accepted;
          const owner = this.conversations.get(request.id);
          if (this.unboundConversationExists(request.id) || owner && (owner !== request.binding.resourceId
            || this.backend(owner).runtime.bindingKind !== request.binding.kind)) throw "conflict";
          const proof = backend.runtime.conversations.createBoundReady(request);
          this.conversations.set(request.id, request.binding.resourceId);
          this.persist(request.binding.resourceId, backend);
          return proof;
        },
        createBoundStatus: async input => this.receipts.status(decodeAgentCreateBoundRequest(input)),
      }, agentArchiveGateway: {
        setArchived: async input => {
          const request = decodeAgentArchiveRequest(input), replay = this.receipts.archiveLookup(request);
          return replay ?? route(b => b.runtime.conversations.archives).setArchived(request);
        },
        archiveStatus: async input => {
          const request = decodeAgentArchiveRequest(input);
          return this.receipts.archiveStatus(request, this.conversations.get(request.id));
        },
      },
      agentDeletionGateway: {
        delete: async (input, options) => {
          const request = decodeAgentDeletionRequest(input);
          const precondition = options === undefined ? undefined : decodeAgentDeletionWriteOptions(options);
          if (this.receipts.deletionReplay(request, precondition, this.conversations.get(request.conversationId)))
            return {schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId};
          return route(b => b.runtime.conversations.deletions).delete(request, precondition);
        },
        status: async request => this.receipts.deletionStatus(request, this.conversations.get(request.conversationId)),
      }, agentSearchGateway: route(b => b.runtime.conversations.search),
      agentConversationExportGateway: {
        snapshot: async () => { throw new Error("预览暂不提供真实导出文件"); },
        download: async id => {
          const {backend} = await this.select([id]);
          const row = await backend.runtime.conversations.metadata.read({id});
          return {schemaVersion: 1, conversationId: id, watermark: row.durableCount,
            destinationPath: `preview-downloads/${row.title}.json`, byteSize: 0};
        },
      },
      agentForkGateway: {
        fork: route(b => b.runtime.conversations.forks).fork,
        status: async request => this.receipts.forkStatus(request),
      }, agentForkOriginGateway: route(b => b.runtime.conversations.forkOrigin),
      getAgentUndoEditorRestorationGateway: scope => this.backend(scope.manuscriptId).agent.gateways.application.undoRestorations(scope),
      agentSteeringRecoveryGateway: { readWritingRecovery: async request => ({ schemaVersion: 1, ...request, inputs: [] }) },
      agentQueueAdmissionsGateway: { list: async request => ({ schemaVersion: 1, conversationId: request.conversationId, manuscriptId: request.manuscriptId, items: [], nextCursor: null }) },
      agentInstructionTrustGateway: { read: async manuscriptId => JSON.parse(this.storage.getItem(`trust:${manuscriptId}`) ?? JSON.stringify({ schemaVersion: 1, manuscriptId, revision: 0, granted: false, rootMatches: false })), update: async (manuscriptId, expectedRevision, granted) => { const current = JSON.parse(this.storage.getItem(`trust:${manuscriptId}`) ?? "{\"revision\":0}") as { revision: number }; if (current.revision !== expectedRevision) throw new Error("模拟指令信任版本冲突"); const next = { schemaVersion: 1 as const, manuscriptId, revision: expectedRevision + 1, granted, rootMatches: granted }; this.storage.setItem(`trust:${manuscriptId}`, JSON.stringify(next)); return next; } },
      agentSessionGateway: route(b => b.agent.gateways.delivery.sessions), agentTurnGateway: route(b => b.runtime.gateways.turns),
      agentSubmissionGateway: route(b => b.runtime.gateways.submission), agentInputQueueGateway: route(b => b.runtime.queue.gateway),
      agentCompactionGateway: route(b => b.runtime.compaction.gateway),
      agentInputQueuePreviewGateway: route(b => b.runtime.queue.preview),
      agentSteeringGateway: route(b => ({ steerWriting: b.runtime.gateways.steering.send })),
      agentWorkspaceGateway: route(b => b.runtime.gateways.workspace), agentWorkspaceReviewGateway: route(b => b.agent.reviews),
      agentProposalGateway: route(b => b.agent.gateways.delivery.proposals), agentWritingFileDeliveryGateway: route(b => b.agent.gateways.delivery.deliveries),
      agentApplicationGateway: route(b => b.agent.gateways.application.applications), agentEditorRestorationGateway: route(b => b.agent.gateways.application.restorations),
      agentUndoGateway: route(b => b.agent.gateways.application.undos), agentPendingWritingUndoGateway: route(b => b.agent.gateways.pendingUndos),
      agentPendingWritingApplicationGateway: route(b => b.agent.gateways.pendingApplications),
      agentSubtaskGateway: route(b => ({ ...b.runtime.gateways.subtasks, resumeNote: async () => { throw new Error("模拟回合没有子任务"); }, resumeReadingNote: async () => { throw new Error("模拟回合没有子任务"); }, resumePaper: async () => { throw new Error("模拟回合没有子任务"); } })),
    };
  }
  dispose(): void {
    for (const [id, backend] of this.backends) this.persist(id, backend);
    this.disposed = true;
    for (const backend of this.backends.values()) { backend.agent.history.onChange = undefined; backend.runtime.dispose(); }
  }
}
