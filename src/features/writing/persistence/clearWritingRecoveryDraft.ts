import type { WritingDocumentIdentity } from "@research-assistant/writing";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { WritingDiagnosticSource } from "./WritingStateDiagnostics";

/** Observe the legacy draft's actual I/O; review checkpoints are never cleared here. */
export async function clearWritingRecoveryDraft(files: WritingFileSessions | undefined, identity: WritingDocumentIdentity,
  source: Extract<WritingDiagnosticSource, "save-complete" | "conflict-reload" | "conflict-copy" | "discard-recovery" | "delete-file">,
  clear: () => Promise<void>): Promise<void> {
  const diagnostics = files?.diagnostics;
  if (!diagnostics?.enabled) return clear();
  const before = files?.get(identity)?.read();
  const trace = { ...identity, phase: "draft-clear" as const, source, ...(before ? { before } : {}) };
  const operationId = diagnostics.record({ ...trace, status: "started" });
  const observation = { ...trace, ...(operationId ? { operationId } : {}) };
  try {
    await clear();
    const after = files?.get(identity)?.read();
    diagnostics.record({ ...observation, status: "completed", ...(after ? { after } : {}) });
  } catch (reason) {
    const after = files?.get(identity)?.read();
    diagnostics.record({ ...observation, status: "failed", ...(after ? { after } : {}) });
    throw reason;
  }
}
