import type { AgentWritingQueuedCompactionPrepareRequest, AgentWritingQueuedCompactionSettleRequest } from "@research-assistant/core/agent";
import type { AgentInputQueueGateway } from "@research-assistant/data/agent";
import type { WritingCompactionController, WritingCompactionRequest, WritingCompactionScope } from "./writingCompactionController";
import type { WritingCompactionReceiptStore } from "./writingCompactionReceipt";
import { queuedCompactionConflict, type WritingQueuedCompactionRecovery } from "./writingQueuedCompactionRecovery";

export function queuedCompactionRequest(value: AgentWritingQueuedCompactionPrepareRequest): WritingCompactionRequest {
  const {submission, expectedRevision, ...queued} = value;
  return {request: submission, expectedRevision, queued};
}
export function queuedCompactionRecovery(value: AgentWritingQueuedCompactionPrepareRequest): WritingQueuedCompactionRecovery {
  return {conversationId: value.submission.conversationId, manuscriptId: value.submission.context.manuscriptId,
    requestId: value.submission.requestId, inputId: value.inputId, queued: {prepare: structuredClone(value), settle: null}};
}
/** Reliable recovery is a prerequisite for native mutation, including settlement.
 * The retained compaction controller carries RAM state through a failed flush. */
export async function persistQueuedCompaction(controller: WritingCompactionController, store: WritingCompactionReceiptStore,
  value: WritingQueuedCompactionRecovery): Promise<boolean> {
  controller.setQueuedRecovery(value);
  try {
    if (controller.hasQueuedReservation() && !store.read(value)) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
    store.save(value); await store.flush?.(); controller.queuedReservedDurably(); return true;
  }
  catch { controller.queuedIssue(new Error("COMPACTION_RECOVERY_PERSISTENCE_FAILED")); return false; }
}

export async function settleQueuedCompaction(controller: WritingCompactionController, store: WritingCompactionReceiptStore,
  queue: Pick<AgentInputQueueGateway, "read">, scope: WritingCompactionScope): Promise<boolean> {
  const state = controller.getSnapshot(), preview = state.preview, claim = preview?.queued;
  let recovery = controller.getQueuedRecovery();
  if (!claim || !preview || !state.outcome || !recovery) return false;
  if (controller.getSettlement().phase === "settled") return state.outcome === "completed";
  let request: AgentWritingQueuedCompactionSettleRequest;
  try {
    if (recovery.queued.settle) request = recovery.queued.settle;
    else {
      const current = await queue.read({conversationId: scope.conversationId, manuscriptId: scope.manuscriptId});
      request = {operationId: crypto.randomUUID(), conversationId: scope.conversationId, manuscriptId: scope.manuscriptId,
        inputId: claim.inputId, requestId: claim.requestId, expectedQueueRevision: current.revision, claimRevision: claim.claimRevision};
      recovery = {...recovery, queued: {...recovery.queued, settle: request}};
    }
    const acknowledged = controller.getSettlement().result;
    if (!acknowledged && !(await persistQueuedCompaction(controller, store, recovery))) return false;
    const result = acknowledged ?? await controller.settleQueued(request);
    if (result.inputId !== claim.inputId || result.requestId !== claim.requestId || result.outcome !== state.outcome)
      throw new Error("COMPACTION_QUEUE_CLAIM_MISMATCH");
    // A historical settlement receipt must never install its queue snapshot.
    // The view reloads current queue metadata through its existing controller.
    const present = store.read(recovery);
    if (present && present.requestId !== recovery.requestId) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
    store.clear(recovery); await store.flush?.(); controller.queuedSettled(); controller.setQueuedRecovery(null);
    return result.outcome === "completed";
  } catch (cause: unknown) {
    if (queuedCompactionConflict(cause) && recovery) {
      // A proven CAS rejection permits a later explicit retry to read Q again.
      // Other failures retain the exact original settle operation and Q.
      const retained = {...recovery, queued: {...recovery.queued, settle: null}};
      await persistQueuedCompaction(controller, store, retained);
    }
    controller.queuedIssue(cause); return false;
  }
}
