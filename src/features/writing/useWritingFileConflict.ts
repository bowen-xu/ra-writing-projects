import { clearWritingRecoveryDraft } from "./persistence/clearWritingRecoveryDraft";
import type { ManuscriptFile, ManuscriptFileContent } from "@research-assistant/writing";
import { decodeWritingNote, isWritingNotePath, parseManuscriptPath } from "@research-assistant/writing";
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

import type { WritingGateway } from "./gateway";
import type { PendingFileConflict } from "./useWritingPersistence";
import type { WritingFileSessions } from "./editor/writingFileSessions";
import { errorMessage, type SaveState } from "./workspaceState";

export interface WritingFileConflict extends PendingFileConflict {
  readonly diskFile: ManuscriptFileContent;
}

interface WritingFileConflictOptions {
  readonly fileSessions?: WritingFileSessions;
  readonly gateway: Pick<WritingGateway, "readFile" | "createFile" | "listFiles" | "clearRecoveryDraft">;
  readonly setActivePath: Dispatch<SetStateAction<string | undefined>>;
  readonly setContent: Dispatch<SetStateAction<string>>;
  readonly setContentHash: Dispatch<SetStateAction<string | undefined>>;
  readonly setError: Dispatch<SetStateAction<string | undefined>>;
  readonly setFiles: Dispatch<SetStateAction<readonly ManuscriptFile[]>>;
  readonly setOpenPaths: Dispatch<SetStateAction<readonly string[]>>;
  readonly setSaveState: Dispatch<SetStateAction<SaveState>>;
}

export interface WritingFileConflictController {
  readonly conflict: WritingFileConflict | undefined;
  readonly keepEditing: () => void;
  readonly onConflict: (conflict: PendingFileConflict) => void;
  readonly reload: () => void;
  readonly saveAs: (relativePath: string) => Promise<boolean>;
}

export function useWritingFileConflict(
  options: WritingFileConflictOptions,
): WritingFileConflictController {
  const [conflict, setConflict] = useState<WritingFileConflict>();

  const onConflict = useCallback((pending: PendingFileConflict) => {
    async function loadDiskVersion(): Promise<void> {
      try {
        const diskFile = await options.gateway.readFile(pending.manuscriptId, pending.relativePath);
        setConflict({ ...pending, diskFile });
      } catch (reason: unknown) {
        options.setError(errorMessage(reason));
      }
    }
    void loadDiskVersion();
  }, [options.gateway, options.setError]);

  const keepEditing = useCallback(() => setConflict(undefined), []);

  const reload = useCallback(() => {
    if (conflict === undefined) return;
    options.fileSessions?.get(conflict)?.reloadDisk(conflict.diskFile.content, conflict.diskFile.sha256);
    options.setActivePath(conflict.diskFile.relativePath);
    options.setContent(conflict.diskFile.content);
    options.setContentHash(conflict.diskFile.sha256);
    options.setSaveState("saved");
    setConflict(undefined);
    void clearWritingRecoveryDraft(options.fileSessions, conflict, "conflict-reload", () => options.gateway.clearRecoveryDraft(conflict.manuscriptId, conflict.relativePath))
      .catch((reason: unknown) => options.setError(errorMessage(reason)));
  }, [conflict, options.fileSessions, options.gateway, options.setActivePath, options.setContent, options.setContentHash, options.setError, options.setSaveState]);

  const saveAs = useCallback(async (relativePath: string): Promise<boolean> => {
    if (conflict === undefined) return false;
    try {
      const path = parseManuscriptPath(relativePath);
      if (isWritingNotePath(conflict.relativePath) && !isWritingNotePath(path)) throw new Error("笔记副本必须使用 .ranote 扩展名");
      const bufferedContent = isWritingNotePath(conflict.relativePath)
        ? JSON.stringify({ ...decodeWritingNote(conflict.bufferedContent), noteId: crypto.randomUUID() })
        : conflict.bufferedContent;
      const created = await options.gateway.createFile(
        conflict.manuscriptId,
        path,
        bufferedContent,
      );
      if (!isWritingNotePath(created.relativePath)) {
        options.fileSessions?.open({ manuscriptId: conflict.manuscriptId, relativePath: created.relativePath }, created.content, created.sha256);
      }
      options.setFiles(await options.gateway.listFiles(conflict.manuscriptId));
      options.setOpenPaths((current) => current.includes(created.relativePath)
        ? current
        : [...current, created.relativePath]);
      options.setActivePath(created.relativePath);
      options.setContent(created.content);
      options.setContentHash(created.sha256);
      options.setSaveState("saved");
      setConflict(undefined);
      void clearWritingRecoveryDraft(options.fileSessions, conflict, "conflict-copy", () => options.gateway.clearRecoveryDraft(conflict.manuscriptId, conflict.relativePath))
        .catch((reason: unknown) => options.setError(errorMessage(reason)));
      return true;
    } catch (reason: unknown) {
      options.setError(errorMessage(reason));
      return false;
    }
  }, [conflict, options.fileSessions, options.gateway, options.setActivePath, options.setContent, options.setContentHash, options.setError, options.setFiles, options.setOpenPaths, options.setSaveState]);

  return { conflict, keepEditing, onConflict, reload, saveAs };
}
