import {sourcePath} from "@research-assistant/core/source";
import {lazyMockSystemDocuments} from "../../runtime/mock/mockSystemDocuments";
import type {SourceDirectoryGateways} from "@research-assistant/workbench-preview/source-directory";
import {parseManuscriptPath} from "@research-assistant/writing";
import {getAppStorage} from "@research-assistant/workbench-preview/app-storage";
import { createMockAgentRecoveryStorage } from "../../runtime/mock/MockAgentRecoveryStorage";
import { MockAgentResourceRuntime } from "@research-assistant/workbench-preview/mock-agent-resource-runtime";
import { MockAgentCommandGateway } from "@research-assistant/workbench-preview/mock-agent-command-gateway";
import { MockWritingCompactionGateway } from "@research-assistant/workbench-preview/mock-writing-compaction-gateway";
import { createWritingDemoContextGateway } from "@research-assistant/workbench-preview/writing-demo-context-gateway";
import { writingDemoContextCatalog } from "@research-assistant/workbench-preview/writing-demo-context-catalog";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
import {decodeAgentWritingStartRequest} from "@research-assistant/core/agent";
import {mockWritingStartUnconfirmed} from "@research-assistant/workbench-preview/mock-writing-start-observation";
import { AgentInputQueueRegistry, AgentSteeringHandoffRegistry, AgentSteeringRegistry, type AgentSubmissionGateway } from "@research-assistant/data/agent";
import { createWritingDemoModelGateway } from "@research-assistant/workbench-preview/writing-demo-model-gateway";
import type { AgentConversationBinding, AgentWritingQueueScope, AgentWritingQueueResponse } from "@research-assistant/core/agent";
import type { WritingAgentRuntimeGateways, WritingSteeringScope } from "../../../../../src/features/writing/agent/writingRuntimeGateways";
import type { WritingAgentHistoryAccess } from "../../../../../src/features/writing/useWritingAgentHistory";
import { WritingDiffDemoConversations } from "./WritingDiffDemoConversations";
import { WritingDiffDemoSubmission } from "./WritingDiffDemoSubmission";
import { WritingDiffDemoQueue } from "@research-assistant/workbench-preview/writing-diff-demo-queue";
import { createWritingDemoHandoffGateway } from "./WritingDemoHandoffGateway";
import type { WritingDiffDemoStorage } from "../../../../agent/WritingDiffDemoStorage";
import type { WritingDiffDemoAgentStorage } from "./WritingDiffDemoAgentStorage";

const unavailable = async (): Promise<never> => { throw new Error("此操作尚未接入模拟运行网关"); };

/** Compose replaceable external I/O; all UI/controllers come from production. */
export function createWritingDiffDemoRuntime(storage: Pick<WritingDiffDemoStorage, "files" | "checkpoints">, agent: WritingDiffDemoAgentStorage,
  manuscriptId: string, conversationId: string, bindingKind: AgentConversationBinding["kind"] = "manuscript") {
  const resources=new MockAgentResourceRuntime(async scope=>{if(scope.kind!=="manuscript"||scope.resourceId!==manuscriptId)throw "unbound";return Promise.all((await storage.files.listFiles(manuscriptId)).filter(file=>file.kind!=="image").map(async file=>({group:"files" as const,label:file.relativePath,source:"当前稿件",input:{type:"mention" as const,name:file.relativePath,target:{kind:"file" as const,sourceId:`writing:${await writingDiffDemoHash(`${manuscriptId}/${file.relativePath}`)}`,resourceId:file.relativePath,sourceUrl:sourcePath("writings",manuscriptId,...file.relativePath.split("/"))}}})));});
  const model = createWritingDemoModelGateway();
  const commands = new MockAgentCommandGateway();
  const identity = crypto.randomUUID(), execution = new WritingDiffDemoSubmission(storage, agent, manuscriptId,resources);
  const submission: AgentSubmissionGateway = { ...execution.submission, startWriting: async request => {
    if (compaction.hasPrepared(request)) throw { code: "confirmationMismatch" };
    return execution.submission.startWriting(request);
  }, startStatus: async input => {const intent=decodeAgentWritingStartRequest(input); return compaction.hasPrepared(intent)
    ? {schemaVersion:1,intent,status:mockWritingStartUnconfirmed(intent.requestId,"writing_start_purpose_mismatch")}
    : execution.submission.startStatus(intent); } };
  const queue: WritingDiffDemoQueue = new WritingDiffDemoQueue(submission, id => agent.history.assertAvailable(id), request => execution.materializeCompaction(request, "queuedRegular"), scope => execution.inspectFrozen(scope),
    {validate: request => execution.validateQueuedStart(request), inspect: (request, preview) => execution.inspectStarted(request, preview)},
    intent => compaction.prepareCancellation(intent));
  const compaction = new MockWritingCompactionGateway({materialize: (request, purpose) => execution.materializeCompaction(request, purpose ?? "manualCompact"),
    inspect: receipt => execution.inspectPreparation(receipt)}, agent.history, queue, commands);
  const conversations = new WritingDiffDemoConversations(manuscriptId, agent, conversationId,
    id => { execution.deleteConversation(id); queue.deleteConversation(id); compaction.deleteConversation(id); }, id => execution.hasExecutionWorkspace(id), bindingKind);
  queue.bindHandoffEnvironment(()=>conversations.dataEpoch());
  const handoffGateway=createWritingDemoHandoffGateway(queue,agent.history,execution,manuscriptId,async id=>{
    const metadata=await conversations.metadata.read({id,binding:{kind:"manuscript",resourceId:manuscriptId}});
    if(metadata.archived)throw {code:"conflict"};
  });
  const handoffRegistry=new AgentSteeringHandoffRegistry(handoffGateway,(request,scope)=>{
    if(scope.kind!=="manuscript"||scope.manuscriptId!==manuscriptId)throw new Error("MOCK_HANDOFF_SCOPE_MISMATCH");
    return execution.steer({...request,manuscriptId});
  },()=>crypto.randomUUID(),scope=>scope.kind==="manuscript"&&scope.manuscriptId===manuscriptId);
  const queueRegistry = new AgentInputQueueRegistry<AgentWritingQueueScope, AgentWritingQueueResponse>(queue.gateway, scope => JSON.stringify([scope.manuscriptId, scope.conversationId]), () => crypto.randomUUID());
  const steeringRegistry = new AgentSteeringRegistry<WritingSteeringScope>(execution.steer, () => crypto.randomUUID());
  const gateways: WritingAgentRuntimeGateways = {
    history: agent.gateways.delivery.sessions,
    contextUsage: (conversationId, _model, signal) => compaction.readUsage({ conversationId, signal }),
    context: {...createWritingDemoContextGateway(agent.gateways.delivery.sessions, {
      manuscriptId, catalog: async () => writingDemoContextCatalog(manuscriptId, (await storage.files.listFiles(manuscriptId)).filter(file => ["tex", "bib", "style"].includes(file.kind)).map(file => file.relativePath)),
    }),steeringHandoff:handoffGateway},
    messageInspection: async request => ({ schemaVersion: 1, ...request, userInput: execution.inspectUserInput(request), events: agent.history.inspectMessage(request),
      frozenSubmission: request.referencesOnly ? null : execution.inspectSubmission(request.conversationId, request.turnId) }),
    resources: { ...resources.gateways, systemDocuments: lazyMockSystemDocuments(getAppStorage), conversationResources: async query => {
      const files = await resources.gateways.hostResources!({ kind: "manuscript", resourceId: manuscriptId, conversationId });
      return files.filter(file => file.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    } },
    commands,
    identity, submission, ...(bindingKind === "manuscript" ? { compaction: compaction.gateway } : {}), workspace: execution.workspace,
    turns: { interrupt: async request => {
      if (agent.history.activeTurn(request.conversationId) === request.turnId)
        queue.pauseForStop({ manuscriptId, conversationId: request.conversationId });
      return await compaction.interrupt(request) ?? execution.turns.interrupt(request);
    } }, queuePreview: queue.preview,
    queue: { gateway: queue.gateway, registry: queueRegistry }, steering: { send: execution.steer, registry: steeringRegistry }, steeringHandoff:handoffRegistry,
    creation: conversations.creation, metadata: conversations.metadata, catalog: conversations.catalog,
    subtasks: { list: async () => [], reconcile: unavailable, resumeWriting: unavailable }, fork: conversations.forks,
    forkOrigin: conversations.forkOrigin,
    retrieval: { previewConceptRetrieval: unavailable, cancelConceptRetrievalPreview: unavailable },
    model: model.gateway,
    review: { workspaceReviewGateway: agent.reviews, proposalGateway: agent.gateways.delivery.proposals,
      workspaceDiscardGateway: { find: unavailable, preview: unavailable, discard: unavailable } },
  };
  const history: WritingAgentHistoryAccess = { identity, gateway: agent.gateways.delivery.sessions,
    metadata: conversations.metadata, selection: conversations.selection };
  const sourceHints: SourceDirectoryGateways = {
    literature: {get: unavailable},
    notes: {loadDocument: unavailable, listPages: async () => [], listLiteratureNotes: async () => [], listReadingNotes: async () => [], getReadingNote: unavailable},
    writing: {listFiles: storage.files.listFiles, listManuscripts: async () => [{id: manuscriptId, title: "Diff 演示稿件", rootPath: parseManuscriptPath("demo"), status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z"}]},
  };
  return { bindingKind, setModelMode: model.setMode, identity, conversations, execution, resources,queue,compaction,gateways, history,
    sourceHints,
    // This synthetic runtime has no managed image captures to reconcile.
    reconcileEvidence: () => Promise.resolve(),
    setCompactionDuration: (durationMs: number) => { commands.delayMs = durationMs; },
    listGateways: { catalog: conversations.catalog, metadata: conversations.metadata, archives: conversations.archives,
      deletionRecoveryStorage: createMockAgentRecoveryStorage(`writing-diff:${manuscriptId}`),
      search: conversations.search, deletions: conversations.deletions, batchDeletions: conversations.batchDeletions, exports: { snapshot: unavailable, download: unavailable } },
    retain: () => { const releaseQueue = queueRegistry.retain(), releaseSteering = steeringRegistry.retain(),releaseHandoff=handoffRegistry.retain();
      return () => { releaseQueue(); releaseSteering(); releaseHandoff(); }; },
    dispose: () => { compaction.dispose(); commands.dispose(); execution.dispose(); queueRegistry.dispose(); steeringRegistry.dispose(); handoffRegistry.dispose(); agent.history.dispose(); },
  };
}
