import { errorCode, errorMessage } from "../workspaceState";
import type { PendingFileConflict } from "../useWritingPersistence";

/** Both workspace and preview route protected save failures to the same recovery controller. */
export function handleWritingSaveFailure(reason: unknown, snapshot: PendingFileConflict,
  onConflict: (conflict: PendingFileConflict) => void, onError: (message: string) => void): void {
  if (errorCode(reason) === "file_conflict") onConflict(snapshot);
  else onError(errorMessage(reason));
}
