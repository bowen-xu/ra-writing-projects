import {decodeAgentWritingCompactionPrepareRequest, decodeAgentWritingCompactionPreview, decodeAgentWritingPrepareResult,
  agentWritingCompactionStartRequest, decodeAgentCompactionStartRequest, decodeAgentStartResponse,
  type AgentCompactionStartRequest, type AgentStartResponse, type AgentWritingReceipt, type AgentWritingCompactionPrepareRequest, type AgentWritingCompactionPreview} from "@research-assistant/core/agent";
import {decodeWritingCompactionReceipt} from "./writingCompactionReceiptIdentity";
import {writingPreparationRejection, type WritingPreparationRejection} from "@research-assistant/workbench-sdk/agent-writing";
import {decodeWritingDraftAcknowledgment} from "@research-assistant/workbench-sdk/agent-writing";
import type { ConversationDraftAcknowledgmentToken } from "@research-assistant/workbench-sdk/agent-drafts";
export interface WritingManualCompactionRecovery extends AgentWritingReceipt {
  readonly manual: {
    readonly prepare: AgentWritingCompactionPrepareRequest;
    readonly result: AgentWritingCompactionPreview | null;
    readonly knownRejected: boolean;
    readonly rejection: WritingPreparationRejection | null;
    readonly draftAcknowledgment: ConversationDraftAcknowledgmentToken | null;
    readonly start: {readonly request: AgentCompactionStartRequest; readonly result: AgentStartResponse | null} | null;
  };
}
export function isWritingManualCompactionRecovery(value: AgentWritingReceipt): value is WritingManualCompactionRecovery {
  return "manual" in value;
}
export const writingManualPreparationRejection = (cause: unknown, prepare: AgentWritingCompactionPrepareRequest): WritingPreparationRejection | null => writingPreparationRejection(cause, prepare.request, true);
export function decodeWritingManualCompactionRecovery(value: unknown): WritingManualCompactionRecovery {
  const receipt = decodeWritingCompactionReceipt(value);
  if (!value || typeof value !== "object" || !("manual" in value) || !value.manual || typeof value.manual !== "object" || Array.isArray(value.manual)) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  const row = value.manual as Record<string, unknown>;
  const extended = Object.hasOwn(row, "draftAcknowledgment") || Object.hasOwn(row, "start");
  if (Object.keys(row).sort().join() !== (extended ? "draftAcknowledgment,knownRejected,prepare,rejection,result,start" : "knownRejected,prepare,rejection,result")
    || !Object.hasOwn(row, "prepare") || !Object.hasOwn(row, "result") || typeof row.knownRejected !== "boolean"
    || !Object.hasOwn(row, "rejection")) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  const prepare = decodeAgentWritingCompactionPrepareRequest(row.prepare);
  const rejection = row.rejection === null ? null : writingManualPreparationRejection(row.rejection, prepare);
  if (row.rejection !== null && rejection === null) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  if (prepare.request.conversationId !== receipt.conversationId || prepare.request.requestId !== receipt.requestId || prepare.request.context.manuscriptId !== receipt.manuscriptId) throw new Error("COMPACTION_RECOVERY_RECEIPT_SCOPE_MISMATCH");
  const result = row.result === null ? null : decodeAgentWritingCompactionPreview(row.result);
  if (result) {decodeAgentWritingPrepareResult(result.preview, prepare.request); if (result.expectedRevision !== prepare.expectedRevision) throw new Error("COMPACTION_PREPARATION_SCOPE_MISMATCH");}
  if (row.knownRejected && (row.rejection === null || result)) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  const draftAcknowledgment = extended ? decodeWritingDraftAcknowledgment(row.draftAcknowledgment, receipt) : null;
  let start: NonNullable<WritingManualCompactionRecovery["manual"]["start"]> | null = null;
  if (extended && row.start !== null) {
    if (!row.start || typeof row.start !== "object" || Array.isArray(row.start) || Object.keys(row.start).sort().join() !== "request,result" || !result)
      throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
    const value = row.start as Record<string, unknown>, request = decodeAgentCompactionStartRequest(value.request);
    if (JSON.stringify(request) !== JSON.stringify(agentWritingCompactionStartRequest(result))) throw new Error("COMPACTION_PREPARATION_SCOPE_MISMATCH");
    const started = value.result === null ? null : decodeAgentStartResponse(value.result);
    if (started && (started.conversationId !== receipt.conversationId || started.requestId !== receipt.requestId || started.turnId !== result.preview.turnId))
      throw new Error("COMPACTION_ADMISSION_IDENTITY_MISMATCH");
    start = {request, result: started};
  }
  return {...receipt, manual: {prepare, result, knownRejected: row.knownRejected, rejection, draftAcknowledgment, start}};
}
