import { clearWritingRecoveryDraft } from "./persistence/clearWritingRecoveryDraft";
import { parseManuscriptPath, type ManuscriptFile } from "@research-assistant/writing";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { WritingGateway } from "./gateway/writingGateway";
import { errorCode, errorMessage, type SaveState } from "./workspaceState";
import type { WritingFileSessions } from "./editor/writingFileSessions";
import type { WritingCheckpointPersistence } from "./persistence/WritingCheckpointPersistence";
import type { WritingFileSaveQueue } from "./persistence/WritingFileSaveQueue";
import { handleWritingSaveFailure } from "./persistence/writingSaveFailure";
import { EDITOR_AUTOSAVE_IDLE_MS } from "@research-assistant/workbench-sdk/document-recovery";

export interface PendingFileConflict {
  readonly bufferedContent: string;
  readonly manuscriptId: string;
  readonly relativePath: string;
}

interface WritingPersistenceOptions {
  /** Auxiliary document windows share file saves, not the manuscript tab layout. */
  readonly persistWorkspaceSession?: boolean;
  readonly activeManuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly content: string;
  readonly contentHash: string | undefined;
  readonly cursorOffsets: Readonly<Record<string, number>>;
  readonly gateway: WritingGateway;
  readonly fileSessions?: WritingFileSessions;
  readonly checkpoints?: WritingCheckpointPersistence;
  readonly fileSaves?: WritingFileSaveQueue;
  readonly openPaths: readonly string[];
  readonly layoutState: Readonly<Record<string, unknown>>;
  readonly onFileConflict: (conflict: PendingFileConflict) => void;
  readonly saveState: SaveState;
  readonly setContentHash: Dispatch<SetStateAction<string | undefined>>;
  readonly setError: Dispatch<SetStateAction<string | undefined>>;
  readonly setFiles: Dispatch<SetStateAction<readonly ManuscriptFile[]>>;
  readonly setSaveState: Dispatch<SetStateAction<SaveState>>;
}

export interface WritingSaveSnapshot {
  readonly manuscriptId: string;
  readonly relativePath: string;
  readonly content: string;
  readonly contentHash: string | undefined;
  readonly saveState: SaveState;
  readonly version?: number;
}

interface FlushLatestSaveOptions {
  readonly continueSaving?: () => boolean;
  readonly canPersist?: () => boolean;
  readonly getSnapshot: () => WritingSaveSnapshot | undefined;
  readonly onFailure: (reason: unknown, snapshot: WritingSaveSnapshot) => void;
  readonly onSaved: (snapshot: WritingSaveSnapshot, sha256: string) => void;
  readonly onSaving: (snapshot: WritingSaveSnapshot) => void;
  readonly onSuperseded: (snapshot: WritingSaveSnapshot, sha256: string) => void;
  readonly persist: (snapshot: WritingSaveSnapshot) => Promise<{ readonly sha256: string }>;
}

export async function flushLatestSave(options: FlushLatestSaveOptions): Promise<boolean> {
  let snapshot = options.getSnapshot();
  if (snapshot === undefined) return true;
  if (snapshot.saveState === "saved") return true;

  while (true) {
    if (options.canPersist?.() === false) return false;
    options.onSaving(snapshot);
    let saved: { readonly sha256: string };
    try {
      saved = await options.persist(snapshot);
    } catch (reason: unknown) {
      options.onFailure(reason, snapshot);
      return false;
    }

    const latest = options.getSnapshot();
    if (latest === undefined) return true;
    const sameFile = latest.manuscriptId === snapshot.manuscriptId
      && latest.relativePath === snapshot.relativePath;
    if (!sameFile) return true;
    if (latest.content === snapshot.content && latest.version === snapshot.version) {
      options.onSaved(snapshot, saved.sha256);
      return true;
    }

    options.onSuperseded(snapshot, saved.sha256);
    if (options.continueSaving?.() === false) return false;
    snapshot = {
      ...latest,
      contentHash: saved.sha256,
      saveState: "dirty",
    };
  }
}

export type WritingSavePause = (() => void) & {
  /** Read after acquisition, before collecting the live editor version. This is
   * a persistence observation, not an editor revision or an authorization to edit.
   * Released leases cannot supply a baseline.
   */
  readSnapshot(): WritingSaveSnapshot | undefined;
};

export type WritingPersistenceControl = (() => Promise<boolean>) & {
  /** Synchronize a live editor transaction before an explicit application flush. */
  readonly syncEditorSnapshot?: (snapshot: { readonly manuscriptId: string; readonly relativePath: string; readonly content: string }) => boolean;
  /** Blocks new file saves immediately and waits for an in-flight write. The
   * caller must release in finally; acquisition never flushes a dirty buffer.
   */
  pause(): Promise<WritingSavePause>;
  readonly flushSession?: () => Promise<void>;
};

export function useWritingPersistence(options: WritingPersistenceOptions): WritingPersistenceControl {
  const {
    activeManuscriptId,
    activePath,
    content,
    contentHash,
    cursorOffsets,
    gateway,
    fileSessions,
    checkpoints,
    fileSaves,
    openPaths,
    layoutState,
    onFileConflict,
    saveState,
    setContentHash,
    setError,
    setFiles,
    setSaveState,
  } = options;

  const latestRef = useRef<WritingSaveSnapshot | undefined>(undefined);
  latestRef.current = activeManuscriptId === undefined || activePath === undefined
    ? undefined
    : {
        manuscriptId: activeManuscriptId,
        relativePath: activePath,
        content,
        contentHash,
        saveState,
      };
  const readCurrent = useCallback((): WritingSaveSnapshot | undefined => {
    const snapshot = latestRef.current;
    if (!snapshot) return undefined;
    const session = fileSessions?.get(snapshot);
    if (!session) return snapshot;
    const document = session.read();
    return { ...snapshot, content: document.content, version: document.version,
      contentHash: session.savedSha256 ?? snapshot.contentHash,
      saveState: snapshot.version !== undefined && snapshot.version !== document.version ? "dirty" : snapshot.saveState };
  }, [fileSessions]);
  if (latestRef.current) {
    const document = fileSessions?.get(latestRef.current)?.read();
    if (document) latestRef.current = { ...latestRef.current, content: document.content, version: document.version };
  }
  const activeSaveRef = useRef<Promise<boolean> | undefined>(undefined);
  const drainRequested = useRef(false);
  const lastEdit = useRef({ manuscriptId: activeManuscriptId, path: activePath, content, at: Date.now() });
  if (lastEdit.current.manuscriptId !== activeManuscriptId || lastEdit.current.path !== activePath || lastEdit.current.content !== content) {
    lastEdit.current = { manuscriptId: activeManuscriptId, path: activePath, content, at: Date.now() };
  }
  const pauseCount = useRef(0);
  const immediateSaveRequested = useRef(false);
  const [pauseEpoch, setPauseEpoch] = useState(0);
  const pause = useCallback(async (): Promise<WritingSavePause> => {
    pauseCount.current += 1;
    setPauseEpoch(value => value + 1);
    let releaseFiles: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      pauseCount.current -= 1;
      releaseFiles?.();
      setPauseEpoch(value => value + 1);
    };
    try { releaseFiles = await fileSaves?.pause(); await activeSaveRef.current; } catch (reason) { release(); throw reason; }
    return Object.assign(release, {
      readSnapshot(): WritingSaveSnapshot | undefined {
        if (released) return undefined;
        const snapshot = readCurrent();
        return snapshot === undefined ? undefined : { ...snapshot };
      },
    });
  }, [readCurrent, fileSaves]);

  const saveBuffered = useCallback((immediate: boolean): Promise<boolean> => {
    if (pauseCount.current > 0) return Promise.resolve(false);
    drainRequested.current ||= immediate;
    if (activeSaveRef.current !== undefined) return activeSaveRef.current;
    const operation = flushLatestSave({
      continueSaving: () => drainRequested.current || Date.now() - lastEdit.current.at >= EDITOR_AUTOSAVE_IDLE_MS,
      canPersist: () => pauseCount.current === 0,
      getSnapshot: readCurrent,
      onFailure: (reason, snapshot) => {
        // The shared file queue publishes its failure once to the active-file subscriber.
        if (fileSaves && fileSessions?.get(snapshot)) return;
        const latest = latestRef.current;
        if (latest === undefined || latest.manuscriptId !== snapshot.manuscriptId || latest.relativePath !== snapshot.relativePath) return;
        latestRef.current = { ...latest, saveState: "error" };
        setSaveState("error");
        if (errorCode(reason) === "file_conflict") {
          setError(undefined);
          onFileConflict({
            bufferedContent: latest.content,
            manuscriptId: snapshot.manuscriptId,
            relativePath: snapshot.relativePath,
          });
        } else {
          setError(errorMessage(reason));
        }
      },
      onSaved: (snapshot, sha256) => {
        const latest = latestRef.current;
        if (latest === undefined || latest.manuscriptId !== snapshot.manuscriptId || latest.relativePath !== snapshot.relativePath) return;
        latestRef.current = { ...latest, contentHash: sha256, saveState: "saved" };
        setContentHash(sha256);
        setSaveState("saved");
        void clearWritingRecoveryDraft(fileSessions, snapshot, "save-complete", () => gateway.clearRecoveryDraft(snapshot.manuscriptId, snapshot.relativePath))
          .catch((reason: unknown) => setError(errorMessage(reason)));
        void gateway.listFiles(snapshot.manuscriptId)
          .then(setFiles)
          .catch((reason: unknown) => setError(errorMessage(reason)));
      },
      onSaving: (snapshot) => {
        const latest = latestRef.current;
        if (latest === undefined || latest.manuscriptId !== snapshot.manuscriptId || latest.relativePath !== snapshot.relativePath) return;
        latestRef.current = { ...latest, saveState: "saving" };
        setSaveState("saving");
      },
      onSuperseded: (snapshot, sha256) => {
        const latest = latestRef.current;
        if (latest === undefined || latest.manuscriptId !== snapshot.manuscriptId || latest.relativePath !== snapshot.relativePath) return;
        latestRef.current = { ...latest, contentHash: sha256, saveState: "dirty" };
        setContentHash(sha256);
        setSaveState("dirty");
      },
      persist: async (snapshot) => {
        if (fileSaves && fileSessions?.get(snapshot)) return fileSaves.save(snapshot);
        const session = fileSessions?.get(snapshot);
        if (checkpoints && session && checkpoints.hasPendingSave(snapshot)) {
          await checkpoints.open(snapshot.manuscriptId, await gateway.readFile(snapshot.manuscriptId, snapshot.relativePath));
        }
        const expectedSha256 = session?.savedSha256 ?? snapshot.contentHash;
        if (checkpoints && session && expectedSha256 === undefined) throw new Error("文件保存缺少已核对的磁盘版本");
        const intent = checkpoints && session && snapshot.version !== undefined
          ? await checkpoints.beginSave({ ...session.read(), content: snapshot.content, version: snapshot.version },
            expectedSha256!)
          : undefined;
        const saved = await gateway.saveFile({
          manuscriptId: snapshot.manuscriptId,
          relativePath: parseManuscriptPath(snapshot.relativePath),
          content: snapshot.content,
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
        });
        if (intent && checkpoints) await checkpoints.completeSave(snapshot, intent, saved.sha256);
        else session?.recordSaved(saved.sha256);
        return saved;
      },
    });
    activeSaveRef.current = operation;
    void operation.finally(() => {
      if (activeSaveRef.current === operation) { activeSaveRef.current = undefined; drainRequested.current = false; }
    });
    return operation;
  }, [gateway, fileSessions, checkpoints, fileSaves, readCurrent, onFileConflict, setContentHash, setError, setFiles, setSaveState]);
  const saveCurrent = useCallback(() => saveBuffered(true), [saveBuffered]);

  useEffect(() => {
    if (fileSaves || !fileSessions || activeManuscriptId === undefined || activePath === undefined) return;
    const session = fileSessions.get({ manuscriptId: activeManuscriptId, relativePath: activePath });
    return session?.subscribe((change) => {
      if (!change.immediate || change.diskReloaded) return;
      immediateSaveRequested.current = true;
      if (pauseCount.current === 0) {
        immediateSaveRequested.current = false;
        void saveCurrent();
      }
    });
  }, [activeManuscriptId, activePath, fileSessions, fileSaves, saveCurrent]);

  useEffect(() => fileSaves?.subscribe((event) => {
    const current = latestRef.current;
    if (!current || current.manuscriptId !== event.manuscriptId || current.relativePath !== event.relativePath) return;
    const session = fileSessions?.get(event);
    latestRef.current = { ...current, content: session?.read().content ?? current.content, saveState: event.state,
      contentHash: session?.savedSha256 ?? current.contentHash, ...(session ? { version: session.read().version } : {}) };
    setSaveState(event.state);
    if (session?.savedSha256) setContentHash(session.savedSha256);
    // The shared queue reports storage errors once per manuscript. This host
    // only routes an external conflict to its comparison/recovery controller.
    if (event.state === "error" && errorCode(event.reason) === "file_conflict") {
      handleWritingSaveFailure(event.reason, { manuscriptId: event.manuscriptId, relativePath: event.relativePath, bufferedContent: session?.read().content ?? current.content }, onFileConflict, setError);
    }
  }), [fileSaves, fileSessions, setSaveState, setContentHash, onFileConflict, setError]);

  useEffect(() => {
    if (pauseCount.current > 0) return;
    if (fileSaves && activeManuscriptId && activePath && fileSessions?.get({ manuscriptId: activeManuscriptId, relativePath: activePath })) return;
    if (immediateSaveRequested.current) {
      immediateSaveRequested.current = false;
      void saveCurrent();
      return;
    }
    if (saveState !== "dirty") return;
    const delay = Math.max(0, EDITOR_AUTOSAVE_IDLE_MS - (Date.now() - lastEdit.current.at));
    const timeout = window.setTimeout(() => void saveBuffered(false), delay);
    return () => window.clearTimeout(timeout);
  }, [saveCurrent, saveBuffered, saveState, pauseEpoch, content, activeManuscriptId, activePath, fileSaves, fileSessions]);

  useEffect(() => {
    if (saveState !== "dirty" || activeManuscriptId === undefined || activePath === undefined || contentHash === undefined) return;
    if (checkpoints && fileSessions?.get({ manuscriptId: activeManuscriptId, relativePath: activePath })) return;
    const timeout = window.setTimeout(() => {
      void gateway.saveRecoveryDraft({
        manuscriptId: activeManuscriptId,
        relativePath: parseManuscriptPath(activePath),
        baseSha256: contentHash,
        content,
      }).catch((reason: unknown) => setError(errorMessage(reason)));
    }, EDITOR_AUTOSAVE_IDLE_MS);
    return () => window.clearTimeout(timeout);
  }, [activeManuscriptId, activePath, content, contentHash, gateway, saveState, setError, checkpoints, fileSessions]);

  const sessionRef = useRef(options);
  sessionRef.current = options;
  const flushSession = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current.persistWorkspaceSession === false) return;
    if (current.activeManuscriptId === undefined) return;
    await current.gateway.saveSession({ manuscriptId: current.activeManuscriptId,
      openPaths: current.openPaths.map(parseManuscriptPath),
      ...(current.activePath === undefined ? {} : { activePath: parseManuscriptPath(current.activePath) }),
      cursorState: current.cursorOffsets, layoutState: current.layoutState });
  }, []);
  useEffect(() => {
    if (options.persistWorkspaceSession === false) return;
    if (activeManuscriptId === undefined) return;
    const timeout = window.setTimeout(() => {
      void flushSession().catch((reason: unknown) => setError(errorMessage(reason)));
    }, EDITOR_AUTOSAVE_IDLE_MS);
    return () => window.clearTimeout(timeout);
  }, [activeManuscriptId, activePath, content, cursorOffsets, gateway, layoutState, openPaths, setError, flushSession, options.persistWorkspaceSession]);

  const syncEditorSnapshot = useCallback((snapshot: { readonly manuscriptId: string; readonly relativePath: string; readonly content: string }): boolean => {
    const current = latestRef.current;
    if (current === undefined || current.manuscriptId !== snapshot.manuscriptId || current.relativePath !== snapshot.relativePath) return false;
    latestRef.current = { ...current, content: snapshot.content, saveState: "dirty" };
    setSaveState("dirty");
    return true;
  }, [setSaveState]);

  return useMemo(() => Object.assign(saveCurrent, { pause, syncEditorSnapshot, flushSession }), [saveCurrent, pause, syncEditorSnapshot, flushSession]);
}
