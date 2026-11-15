import type { WritingCheckpointGateway } from "../../../public/contracts/writingCheckpointGateway";
export type { WritingCheckpointGateway } from "../../../public/contracts/writingCheckpointGateway";
import {resolveWritingCheckpointRuntimeGateway} from "@research-assistant/workbench-sdk/writing-runtime";
import { advanceWritingCheckpoint, decodeWritingCheckpointRecord, decodeWritingDocumentCheckpoint,
  type WritingCheckpointRecord, type WritingCheckpointWrite } from "@research-assistant/writing";

/** The receipt describes the original dispatch, not the current candidate. */
export async function validateWritingCheckpointWrite(write: WritingCheckpointWrite): Promise<WritingCheckpointWrite> {
  const checkpoint = decodeWritingDocumentCheckpoint(write.checkpoint);
  const receipt = checkpoint.editorReceipt;
  if (receipt) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receipt.text));
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const operation = checkpoint.operations.find(source => source.operationId === receipt.operationId);
    if (operation?.resultSha256 !== sha256) throw new Error("编辑器回执正文与操作结果不匹配");
  }
  return {expectedRevision: write.expectedRevision, checkpoint};
}

/** The harness owns storage separately from its disposable UI/session lifetime. */
export function createMemoryWritingCheckpointGateway(storage: Map<string, WritingCheckpointRecord>): WritingCheckpointGateway {
  return {
    async save(write) {
      const {checkpoint, expectedRevision} = await validateWritingCheckpointWrite(write);
      const key = JSON.stringify([checkpoint.manuscriptId, checkpoint.relativePath]);
      const next = advanceWritingCheckpoint(storage.get(key), { expectedRevision, checkpoint });
      storage.set(key, next);
      return decodeWritingCheckpointRecord(next);
    },
    async list(manuscriptId) {
      return [...storage.values()].filter((row) => row.checkpoint.manuscriptId === manuscriptId)
        .sort((a, b) => a.checkpoint.relativePath.localeCompare(b.checkpoint.relativePath))
        .map(decodeWritingCheckpointRecord);
    },
  };
}

// The browser manuscript adapter is also process-memory only. Preview harnesses
// inject their own durable mock store rather than using this application store.
const browserCheckpoints = createMemoryWritingCheckpointGateway(new Map());
export function getWritingCheckpointGateway(): WritingCheckpointGateway {
  return resolveWritingCheckpointRuntimeGateway(browserCheckpoints);
}
