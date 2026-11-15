import { useEffect, useMemo } from "react";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { errorMessage } from "../workspaceState";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { WritingGateway } from "../gateway";
import { getWritingCheckpointGateway, type WritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import { WritingFileSaveQueue } from "./WritingFileSaveQueue";

export function useWritingDocumentPersistence(files: WritingFileSessions, gateway: Pick<WritingGateway, "readFile" | "saveFile">, checkpointGateway: WritingCheckpointGateway = getWritingCheckpointGateway(),
  shared?: {readonly checkpoints: WritingCheckpointPersistence; readonly saves: WritingFileSaveQueue} | null) {
  const checkpoints = useMemo(() => shared?.checkpoints ?? new WritingCheckpointPersistence(files, checkpointGateway,
    (reason) => notify.error(errorMessage(reason))), [files, checkpointGateway, shared]);
  const saves = useMemo(() => shared?.saves ?? new WritingFileSaveQueue(files, checkpoints, gateway,
    (reason, identity) => notify.error(errorMessage(reason), { id: `writing-file-status:${identity.manuscriptId}` })), [files, checkpoints, gateway, shared]);
  useEffect(() => shared ? undefined : checkpoints.connect(), [checkpoints, shared]);
  useEffect(() => shared ? undefined : saves.connect(), [saves, shared]);
  return { checkpoints, saves };
}
