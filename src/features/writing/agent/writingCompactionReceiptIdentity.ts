import type {AgentWritingReceipt} from "@research-assistant/core/agent";
export function writingCompactionIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value) || value === "00000000-0000-0000-0000-000000000000")
    throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  return value.toLowerCase();
}
export function decodeWritingCompactionReceipt(value: unknown): AgentWritingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("conversationId" in value) || !("requestId" in value) || !("manuscriptId" in value))
    throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID");
  return {conversationId: writingCompactionIdentity(value.conversationId), requestId: writingCompactionIdentity(value.requestId), manuscriptId: writingCompactionIdentity(value.manuscriptId)};
}
