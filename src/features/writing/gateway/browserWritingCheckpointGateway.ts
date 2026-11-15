import {advanceWritingCheckpoint, decodeWritingCheckpointRecord, type WritingCheckpointRecord} from "@research-assistant/writing";
import {decodeMockState, encodeMockState} from "../../../../../../apps/web/src/core/public/storage";
import {storagePersistence} from "../../../../../../apps/web/src/core/public/storage";
import {writingFileKey, writingRecords, type WritingRecordAccess} from "../../../../../../apps/web/src/core/public/writingStorage";
import {createMemoryWritingCheckpointGateway, validateWritingCheckpointWrite, type WritingCheckpointGateway} from "./writingCheckpointGateway";

const checkpointWrites = new WeakMap<WritingRecordAccess, Promise<void>>();
function serializeCheckpointWrite<T>(records: WritingRecordAccess, operation: () => Promise<T>): Promise<T> {
  const result = (checkpointWrites.get(records) ?? Promise.resolve()).then(operation);
  // Share the queue across gateway recreation, without retaining completed text.
  checkpointWrites.set(records, result.then(() => undefined, () => undefined));
  return result;
}

/** Checkpoints share the preview connection/flush barrier, but never its startup KV projection. */
export function createBrowserWritingCheckpointGateway(storage: Storage): WritingCheckpointGateway {
  const records = writingRecords(storage);
  if (records) return recordCheckpoints(records);
  if (storagePersistence(storage)) throw Object.assign(new Error("writing_storage_unavailable：预览检查点存储不可用，未使用临时副本。"), {code: "writing_storage_unavailable"});
  // Explicit memory/local Storage harnesses retain their fixture format. Delay
  // decoding until a checkpoint is actually requested, and never rewrite on read.
  let memory: WritingCheckpointGateway | undefined;
  let rows: Map<string, WritingCheckpointRecord>;
  const gateway = () => {
    if (!memory) {
      rows = decodeMockState(storage.getItem("writing-checkpoints") ?? encodeMockState(new Map()));
      memory = createMemoryWritingCheckpointGateway(rows);
    }
    return memory;
  };
  return {
    list: manuscriptId => gateway().list(manuscriptId),
    async save(write) {
      const saved = await gateway().save(write);
      storage.setItem("writing-checkpoints", encodeMockState(rows));
      return saved;
    },
  };
}

function recordCheckpoints(records: WritingRecordAccess): WritingCheckpointGateway {
  return {
    async list(manuscriptId) {
      if (typeof manuscriptId !== "string" || !manuscriptId.length) throw Object.assign(new Error("writing_checkpoint_scope_invalid：读取检查点必须指定稿件。"), {code: "writing_checkpoint_scope_invalid"});
      const snapshot = await records.read([{store: "writingCheckpoints", manuscriptId}]);
      return (snapshot.rows.writingCheckpoints ?? []).map(value => {
        const row = decodeWritingCheckpointRecord(value);
        if (row.checkpoint.manuscriptId !== manuscriptId) throw new Error("写作检查点稿件身份不匹配");
        return row;
      }).sort((a, b) => a.checkpoint.relativePath.localeCompare(b.checkpoint.relativePath));
    },
    async save(write) {
      const validated = await validateWritingCheckpointWrite(write);
      return serializeCheckpointWrite(records, async () => {
        const {manuscriptId, relativePath} = validated.checkpoint;
        const key = writingFileKey(manuscriptId, relativePath);
        for (let attempt = 0; ; attempt++) {
          const snapshot = await records.read([{store: "writingCheckpoints", keys: [key]}]);
          const raw = snapshot.rows.writingCheckpoints?.[0];
          const previous = raw === undefined ? undefined : decodeWritingCheckpointRecord(raw);
          const next = advanceWritingCheckpoint(previous, validated);
          if (previous && JSON.stringify(next) === JSON.stringify(previous)) return next;
          try {
            await records.commit(snapshot.revision, [{store: "writingCheckpoints", key, value: next}]);
            return next;
          } catch (reason) {
            // Other checkpoints can advance the recovery domain's revision.
            // Re-read only this key; its original expectedRevision still applies.
            if (attempt >= 3 || !(reason instanceof Error) || !("code" in reason) || reason.code !== "writing_revision_conflict") throw reason;
          }
        }
      });
    },
  };
}
