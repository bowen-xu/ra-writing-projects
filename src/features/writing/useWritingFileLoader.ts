import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { isWritingNotePath, parseManuscriptPath, type ManuscriptFile, type ManuscriptFileContent, type RecoveryDraft } from "@research-assistant/writing";
import type { WritingGateway } from "./gateway";
import { errorCode, errorMessage, type SaveState } from "./workspaceState";
import type { WritingFileSessions } from "./editor/writingFileSessions";
import type { PendingFileConflict } from "./useWritingPersistence";
import type { WritingCheckpointPersistence } from "./persistence/WritingCheckpointPersistence";

interface FileActivation {
  readonly reload?: boolean;
  readonly files?: readonly ManuscriptFile[];
  readonly openPaths?: readonly string[];
}
interface Options {
  readonly canOpen?: () => boolean;
  readonly manuscriptId: string | undefined;
  readonly gateway: WritingGateway;
  readonly fileSessions?: WritingFileSessions;
  readonly checkpoints?: WritingCheckpointPersistence;
  readonly files?: readonly ManuscriptFile[];
  readonly openPaths?: readonly string[];
  readonly activePath?: string | undefined;
  readonly content?: string;
  readonly contentHash?: string | undefined;
  readonly saveState?: SaveState;
  readonly retainedPaths?: (manuscriptId: string) => readonly string[] | undefined;
  readonly onFileConflict?: (conflict: PendingFileConflict) => void;
  readonly setActivePath: Dispatch<SetStateAction<string | undefined>>;
  readonly setOpenPaths: Dispatch<SetStateAction<readonly string[]>>;
  readonly setContent: Dispatch<SetStateAction<string>>;
  readonly setContentHash: Dispatch<SetStateAction<string | undefined>>;
  readonly setSaveState: Dispatch<SetStateAction<SaveState>>;
  readonly setError: Dispatch<SetStateAction<string | undefined>>;
  readonly setPendingRecovery: Dispatch<SetStateAction<RecoveryDraft | undefined>>;
}
export function useWritingFileLoader(options: Options) {
  const current = useRef(options);
  current.current = options;
  const sequence = useRef(0);
  const auxiliary = useRef(new Map<string, {manuscriptId: string; file: ManuscriptFileContent; status: SaveState}>());
  for (const [key, entry] of auxiliary.current) {
    const paths = options.retainedPaths?.(entry.manuscriptId) ?? (entry.manuscriptId === options.manuscriptId ? options.openPaths : undefined);
    if (paths && !paths.includes(entry.file.relativePath)) auxiliary.current.delete(key);
  }
  if (options.manuscriptId && options.activePath && options.content !== undefined && options.contentHash
    && (isWritingNotePath(options.activePath) || /\.bib$/iu.test(options.activePath))) {
    auxiliary.current.set(JSON.stringify([options.manuscriptId, options.activePath]), {manuscriptId: options.manuscriptId,
      file: {relativePath: parseManuscriptPath(options.activePath), content: options.content, sha256: options.contentHash}, status: options.saveState ?? "saved"});
  }
  const open = useCallback(async (path: string, manuscriptId = current.current.manuscriptId, isCurrent: () => boolean = () => true, activation: FileActivation = {}): Promise<ManuscriptFileContent | undefined> => {
    if (manuscriptId === undefined || current.current.canOpen?.() === false) return undefined;
    const request = ++sequence.current;
    const owns = () => request === sequence.current && current.current.manuscriptId === manuscriptId
      && current.current.canOpen?.() !== false && isCurrent();
    current.current.setError(undefined);
    try {
      const host = current.current;
      const identity = {manuscriptId, relativePath: path};
      const isOpen = (activation.openPaths ?? host.openPaths)?.includes(path);
      const retained = isOpen ? host.fileSessions?.get(identity) : undefined;
      const observed = (activation.files ?? host.files)?.find(file => file.manuscriptId === manuscriptId && file.relativePath === path);
      const cached = isOpen ? auxiliary.current.get(JSON.stringify([manuscriptId, path])) : undefined;
      if (!activation.reload && cached && observed?.sha256 === cached.file.sha256 && owns()) {
        host.setActivePath(path); host.setContent(cached.file.content); host.setContentHash(cached.file.sha256);
        host.setSaveState(cached.status); host.setPendingRecovery(undefined);
        return cached.file;
      }
      if (!activation.reload && retained?.savedSha256 && observed?.sha256 === retained.savedSha256 && owns()) {
        const document = retained.read();
        host.setActivePath(path); host.setContent(document.content); host.setContentHash(retained.savedSha256);
        host.setSaveState(host.checkpoints?.isSaved(identity) ? "saved" : "dirty");
        host.setPendingRecovery(undefined);
        return {relativePath: parseManuscriptPath(path), content: document.content, sha256: retained.savedSha256};
      }
      const file = await current.current.gateway.readFile(manuscriptId, path);
      if (!owns()) return undefined;
      const loadedHost = current.current;
      if (isWritingNotePath(file.relativePath) || /\.bib$/iu.test(file.relativePath)) {
        if (cached && cached.status !== "saved" && cached.file.sha256 !== file.sha256 && loadedHost.onFileConflict) {
          loadedHost.onFileConflict({...identity, bufferedContent: cached.file.content}); return undefined;
        }
        auxiliary.current.set(JSON.stringify([manuscriptId, path]), {manuscriptId, file, status: "saved"});
      }
      const session = isWritingNotePath(file.relativePath) || /\.bib$/iu.test(file.relativePath) ? undefined : loadedHost.checkpoints
        ? await loadedHost.checkpoints.open(manuscriptId, file)
        : loadedHost.fileSessions?.open({ manuscriptId, relativePath: file.relativePath }, file.content, file.sha256);
      if (!owns()) return undefined;
      const content = session?.read().content ?? file.content;
      loadedHost.setActivePath(file.relativePath);
      loadedHost.setOpenPaths((paths) => paths.includes(file.relativePath) ? paths : [...paths, file.relativePath]);
      loadedHost.setContent(content);
      loadedHost.setContentHash(file.sha256);
      loadedHost.setSaveState(content === file.content ? "saved" : "dirty");
      loadedHost.setPendingRecovery(undefined);
      return file;
    } catch (reason) {
      if (owns()) {
        const host = current.current;
        const bufferedContent = host.fileSessions?.get({ manuscriptId, relativePath: path })?.read().content;
        if (errorCode(reason) === "file_conflict" && bufferedContent !== undefined && host.onFileConflict) {
          host.onFileConflict({ manuscriptId, relativePath: path, bufferedContent });
        } else host.setError(errorMessage(reason));
      }
      return undefined;
    }
  }, []);
  const activeMetadata = options.files?.find(file => file.manuscriptId === options.manuscriptId && file.relativePath === options.activePath);
  useEffect(() => {
    const host = current.current;
    if (!activeMetadata || !host.manuscriptId || !host.activePath || host.canOpen?.() === false) return;
    const session = host.fileSessions?.get({manuscriptId: host.manuscriptId, relativePath: host.activePath});
    const cached = auxiliary.current.get(JSON.stringify([host.manuscriptId, host.activePath]));
    const hash = session?.savedSha256 ?? cached?.file.sha256;
    if (hash && hash !== activeMetadata.sha256) void open(host.activePath, host.manuscriptId, () => true, {reload: true});
  }, [activeMetadata?.sha256, activeMetadata?.manuscriptId, activeMetadata?.relativePath, open]);
  return open;
}
