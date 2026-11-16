import { decodeAgentNoteQueueResponse, decodeAgentPaperQueueResponse, type AgentNoteQueueScope } from "@research-assistant/core/agent";
import type { AppGateways } from "@research-assistant/workbench-preview/app-gateway-types";
import type { MockWritingAgents } from "./MockWritingAgents";
import type {MockPaperReceipts} from "./mockPaperReceipts";

/** Share mock durable queue edits with the production queue controller. */
export function createMockResearchQueues(agents: MockWritingAgents, submissions: Partial<AppGateways>, paperReceipts: MockPaperReceipts) {
  const gateway = (scope: AgentNoteQueueScope) => agents.backend(scope.scope.resourceId, scope.scope.kind).runtime.queue.gateway;
  const writingScope = (scope: AgentNoteQueueScope) => ({ conversationId: scope.conversationId, manuscriptId: scope.scope.resourceId });
  const read: AppGateways["agentNoteQueueGateway"]["read"] = async scope => {
    const { manuscriptId: _id, ...state } = await gateway(scope).read(writingScope(scope));
    return decodeAgentNoteQueueResponse({ ...state, scope: scope.scope });
  };
  const notes: AppGateways["agentNoteQueueGateway"] = {
    read,
    edit: async request => { const { manuscriptId: _id, ...state } = await gateway(request).edit({ ...writingScope(request), requestId: request.requestId, expectedRevision: request.expectedRevision, edit: request.edit }); return decodeAgentNoteQueueResponse({ ...state, scope: request.scope }); },
    prepare: async request => {
      const submission = request.submission;
      const preview = submission.kind === "note" ? await submissions.agentNoteSubmissionGateway!.prepare(submission.request) : await submissions.agentReadingNoteSubmissionGateway!.prepare(submission.request);
      const scope: AgentNoteQueueScope = { conversationId: preview.conversationId, scope: { kind: submission.kind, resourceId: "pageId" in preview ? preview.pageId : preview.readingNoteId } };
      const current = await read(scope);
      if (current.revision !== request.expectedRevision || current.inputs.find(value => !value.paused)?.inputId !== request.inputId) throw new Error("模拟队列已变化");
      // Pause the durable queue while the existing confirmation UI owns the preview.
      const next = await notes.edit({ ...scope, requestId: crypto.randomUUID(), expectedRevision: current.revision, edit: { type: "pause" } });
      const { schemaVersion: _version, ...record } = preview;
      return { schemaVersion: 1, inputId: request.inputId, scope: scope.scope, record, queue: { ...next, preparingInputId: request.inputId } };
    },
    recover: async () => null,
    cancel: async request => { const current = await read(request); return notes.edit({ ...request, expectedRevision: current.revision, edit: { type: "pause" } }); },
    start: async (scope, record, confirmation, mode) => {
      const current = await read(scope);
      if (current.revision !== confirmation.expectedRevision) throw new Error("模拟队列已变化");
      const response = scope.scope.kind === "note" ? await submissions.agentNoteSubmissionGateway!.start({ schemaVersion: 1, ...record, pageId: scope.scope.resourceId }, mode) : await submissions.agentReadingNoteSubmissionGateway!.start({ schemaVersion: 1, ...record, readingNoteId: scope.scope.resourceId }, mode);
      await notes.edit({ ...scope, requestId: crypto.randomUUID(), expectedRevision: current.revision, edit: { type: "remove", inputId: confirmation.inputId } }); return response;
    },
    restore: async (scope, requestId) => {
      const preview = scope.scope.kind === "note" ? await submissions.agentNoteSubmissionGateway!.restore({ conversationId: scope.conversationId, pageId: scope.scope.resourceId, requestId }) : await submissions.agentReadingNoteSubmissionGateway!.restore({ conversationId: scope.conversationId, readingNoteId: scope.scope.resourceId, requestId });
      return { conversationId: preview.conversationId, requestId, turnId: preview.turnId, contextSnapshotId: preview.contextSnapshotId, input: preview.input };
    },
    list: async request => ({ schemaVersion: 1, conversationId: request.conversationId, scope: request.scope, items: [], nextCursor: null }),
  };
  const papers: AppGateways["agentPaperQueueGateway"] = {
    read: async scope => { const { manuscriptId: _id, ...state } = await agents.backend(scope.paperId, "paper").runtime.queue.gateway.read({ manuscriptId: paperReceipts.queueScopeId(scope.paperId), conversationId: scope.conversationId }); return decodeAgentPaperQueueResponse({ ...state, paperId: scope.paperId, inputs: state.inputs.map(input => ({...input, origin: input.origin ?? {kind: "paper", resourceId: scope.paperId}})) }); },
    edit: async request => { if (request.expectedEpoch && request.expectedEpoch !== paperReceipts.epoch) throw new Error("DATA_SQL_OPERATION_CONFLICT: data_epoch_changed"); const { manuscriptId: _id, ...state } = await agents.backend(request.paperId, "paper").runtime.queue.gateway.edit({ manuscriptId: paperReceipts.queueScopeId(request.paperId), conversationId: request.conversationId, requestId: request.requestId, expectedRevision: request.expectedRevision, edit: request.edit }); const result = decodeAgentPaperQueueResponse({ ...state, paperId: request.paperId, inputs: state.inputs.map(input => ({...input, origin: input.origin ?? {kind: "paper", resourceId: request.paperId}})) }); paperReceipts.queueEdit(request, result); return result; },
    inspectEdit: async request => paperReceipts.queueStatus(request),
  };
  return { agentNoteQueueGateway: notes, agentPaperQueueGateway: papers };
}
