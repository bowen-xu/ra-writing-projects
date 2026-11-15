import {sameAgentWritingCompactionPrepareRequest, type AgentWritingReceipt} from "@research-assistant/core/agent";
import { flushStorage, storagePersistence } from "@research-assistant/workbench-sdk/storage";
import { decodeWritingQueuedCompactionRecovery, isWritingQueuedCompactionRecovery, type WritingQueuedCompactionRecovery } from "./writingQueuedCompactionRecovery";
import {decodeWritingManualCompactionRecovery, isWritingManualCompactionRecovery, type WritingManualCompactionRecovery} from "./writingManualCompactionRecovery";
import {decodeWritingCompactionReceipt, writingCompactionIdentity as uuid} from "./writingCompactionReceiptIdentity";
export {decodeWritingCompactionReceipt} from "./writingCompactionReceiptIdentity";

type Scope = Pick<AgentWritingReceipt, "conversationId" | "manuscriptId">;
export interface WritingCompactionReceiptStore {
  read(scope: Scope): AgentWritingReceipt | WritingQueuedCompactionRecovery | WritingManualCompactionRecovery | null;
  save(receipt: AgentWritingReceipt | WritingQueuedCompactionRecovery | WritingManualCompactionRecovery): void;
  clear(receipt: AgentWritingReceipt): void;
  flush?(): Promise<void>;
  retry?(): Promise<void>;
}
function key(scope: Scope): string {
  return `research-assistant:writing-compaction-receipt:v1:${uuid(scope.manuscriptId)}:${uuid(scope.conversationId)}`;
}

/** Reliable recovery envelope. Queued requests retain their exact frozen
 * intent through unknown acknowledgements; native still owns admission. */
export function createWritingCompactionReceiptStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): WritingCompactionReceiptStore {
  const read = (scope: Scope): AgentWritingReceipt | WritingQueuedCompactionRecovery | WritingManualCompactionRecovery | null => {
    const value = storage.getItem(key(scope));
    if (value === null) return null;
    let input: unknown;
    try { input = JSON.parse(value); }
    catch { throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID"); }
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !("schemaVersion" in input) || (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3 && input.schemaVersion !== 4)
      || !("conversationId" in input) || !("requestId" in input) || !("manuscriptId" in input))
      throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
    if (input.schemaVersion === 4 && (!("manual" in input) || !input.manual || typeof input.manual !== "object"
      || !("draftAcknowledgment" in input.manual) || !("start" in input.manual))) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
    const receipt = input.schemaVersion === 3 || input.schemaVersion === 4 ? decodeWritingManualCompactionRecovery(input) : input.schemaVersion === 2 ? decodeWritingQueuedCompactionRecovery(input) : decodeWritingCompactionReceipt(input);
    if (receipt.conversationId !== uuid(scope.conversationId) || receipt.manuscriptId !== uuid(scope.manuscriptId))
      throw new Error("COMPACTION_RECOVERY_RECEIPT_SCOPE_MISMATCH");
    return receipt;
  };
  return {
    read,
    save(receipt) {
      const frozen = isWritingManualCompactionRecovery(receipt) ? decodeWritingManualCompactionRecovery(receipt) : isWritingQueuedCompactionRecovery(receipt) ? decodeWritingQueuedCompactionRecovery(receipt) : decodeWritingCompactionReceipt(receipt);
      const previous = read(frozen);
      if (previous && previous.requestId !== frozen.requestId) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      if (previous && isWritingManualCompactionRecovery(previous) !== isWritingManualCompactionRecovery(frozen)) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      if (previous && isWritingManualCompactionRecovery(previous) && isWritingManualCompactionRecovery(frozen)
        && (!sameAgentWritingCompactionPrepareRequest(previous.manual.prepare, frozen.manual.prepare)
          || JSON.stringify(previous.manual.draftAcknowledgment) !== JSON.stringify(frozen.manual.draftAcknowledgment)
          || (previous.manual.start && (JSON.stringify(previous.manual.start.request) !== JSON.stringify(frozen.manual.start?.request)
            || previous.manual.start.result && JSON.stringify(previous.manual.start.result) !== JSON.stringify(frozen.manual.start?.result))))) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      if (previous && isWritingQueuedCompactionRecovery(previous) && !isWritingQueuedCompactionRecovery(frozen)) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      if (previous && isWritingQueuedCompactionRecovery(previous) && isWritingQueuedCompactionRecovery(frozen) && (previous.inputId !== frozen.inputId
        || (previous.queued.prepare && JSON.stringify(previous.queued.prepare) !== JSON.stringify(frozen.queued.prepare)))) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      storage.setItem(key(frozen), JSON.stringify({ schemaVersion: isWritingManualCompactionRecovery(frozen) ? 4 : isWritingQueuedCompactionRecovery(frozen) ? 2 : 1, ...frozen }));
    },
    clear(receipt) {
      const frozen = decodeWritingCompactionReceipt(receipt);
      if (read(frozen)?.requestId === frozen.requestId) storage.removeItem(key(frozen));
    },
    flush: () => flushStorage(storage as Storage),
    retry: async () => { const port = storagePersistence(storage as Storage); if (port?.error) await port.retry(); },
  };
}
