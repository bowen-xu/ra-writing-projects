import { decodeAgentWritingQueuedCompactionPrepareRequest, decodeAgentWritingQueuedCompactionSettleRequest,
  decodeAgentWritingQueuedCompactionReadRequest, type AgentWritingQueuedCompactionPrepareRequest,
  type AgentWritingQueuedCompactionSettleRequest } from "@research-assistant/core/agent";
import type { WritingCompactionReceipt } from "./writingCompactionController";

export interface WritingQueuedCompactionRecovery extends WritingCompactionReceipt {
  readonly inputId: string;
  readonly queued: {
    readonly prepare: AgentWritingQueuedCompactionPrepareRequest | null;
    readonly settle: AgentWritingQueuedCompactionSettleRequest | null;
  };
}
export function isWritingQueuedCompactionRecovery(value: WritingCompactionReceipt): value is WritingQueuedCompactionRecovery {
  return "queued" in value && "inputId" in value;
}
export function decodeWritingQueuedCompactionRecovery(value: unknown): WritingQueuedCompactionRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  const row = value as Record<string, unknown>;
  const identity = decodeAgentWritingQueuedCompactionReadRequest({conversationId: row.conversationId, manuscriptId: row.manuscriptId,
    inputId: row.inputId, requestId: row.requestId});
  if (identity.requestId === null || !row.queued || typeof row.queued !== "object" || Array.isArray(row.queued)) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  const source = row.queued as Record<string, unknown>;
  if (Object.keys(source).some(key => key !== "prepare" && key !== "settle") || !Object.hasOwn(source, "prepare") || !Object.hasOwn(source, "settle")) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  const prepare = source.prepare === null ? null : decodeAgentWritingQueuedCompactionPrepareRequest(source.prepare);
  const settle = source.settle === null ? null : decodeAgentWritingQueuedCompactionSettleRequest(source.settle);
  if ((prepare && (prepare.submission.conversationId !== identity.conversationId || prepare.submission.requestId !== identity.requestId
    || prepare.submission.context.manuscriptId !== identity.manuscriptId || prepare.inputId !== identity.inputId))
    || (settle && (settle.conversationId !== identity.conversationId || settle.manuscriptId !== identity.manuscriptId
      || settle.requestId !== identity.requestId || settle.inputId !== identity.inputId))) throw new Error("COMPACTION_QUEUE_CLAIM_MISMATCH");
  return {...identity, requestId: identity.requestId, queued: {prepare, settle}};
}

export function queuedCompactionConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const row = cause as {code?: unknown; reason?: unknown};
  return row.code === "conflict" || (row.code === "queue" && !!row.reason && typeof row.reason === "object"
    && "code" in row.reason && row.reason.code === "conflict");
}
