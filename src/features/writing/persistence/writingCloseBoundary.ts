import type { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import type { WritingFileSaveQueue } from "./WritingFileSaveQueue";

/** Formal-save failures are recoverable only after every complete checkpoint is acknowledged. */
export async function prepareWritingClose(options: {
  readonly saves: Pick<WritingFileSaveQueue, "flushAll">;
  readonly checkpoints: Pick<WritingCheckpointPersistence, "flushAll">;
  readonly flushSession: () => Promise<void>;
  readonly onRecoverable: (failures: readonly unknown[]) => void;
  readonly onFailure: (reason: unknown) => void;
}): Promise<boolean> {
  try {
    const failures = [...await options.saves.flushAll()];
    await options.checkpoints.flushAll();
    try { await options.flushSession(); } catch (reason) { failures.push(reason); }
    if (failures.length) options.onRecoverable(failures);
    return true;
  } catch (reason) { options.onFailure(reason); return false; }
}
