import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentEditorSessionPort } from "@research-assistant/core/agent";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { useWritingDocumentPersistence } from "./useWritingDocumentPersistence";
import { useWritingCloseBoundary } from "./useWritingCloseBoundary";
import { prepareWritingClose } from "./writingCloseBoundary";
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
import { errorCode, errorMessage, type SaveState } from "../workspaceState";
import { isWritingNotePath, isWritingSourcePath, type ManuscriptFile, type RecoveryDraft } from "@research-assistant/writing";
import { useWritingFileConflict } from "../useWritingFileConflict";
import { handleWritingSaveFailure } from "./writingSaveFailure";
import { useWritingPersistence } from "../useWritingPersistence";
import { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import { useWritingFileApplications, type WritingFileApplicationGateways } from "../agent/useWritingFileApplications";
import type { WritingGateway } from "../../../public/writingGateway";
import type { WritingCheckpointGateway } from "../../../public/writingCheckpointGateway";
import { captureWritingEditor } from "../editor/editorSession";
import { useWritingFileLoader } from "../useWritingFileLoader";
import { useWritingNavigation } from "../useWritingNavigation";
import {useOptionalWritingFileRuntime, useWritingFileApplicationHost, useWritingProjectFiles} from "./WritingFileRuntimeProvider";

export interface WritingDocumentsOptions {
  /** A new fixture/environment is a new file owner; chat selection is not. */
  readonly identity: string;
  readonly manuscriptId: string;
  readonly gateway: WritingGateway;
  readonly checkpointGateway: WritingCheckpointGateway;
  readonly agentGateways?: WritingFileApplicationGateways;
  /** Sampled only when this owner or its I/O ports change. */
  readonly initialOpenPaths: readonly string[];
  readonly persistWorkspaceSession?: boolean;
  readonly admissionsBlocked?: boolean;
}

/** Production file sessions, persistence and application owners with injected I/O.
 * Preserve this tree through prepareClose and native task/ACK drainage before
 * replacing its identity, manuscript or I/O ports. */
export function useWritingDocuments(options: WritingDocumentsOptions) {
  const { identity, manuscriptId, checkpointGateway, agentGateways } = options;
  const owner = useOptionalWritingFileRuntime();
  const lifetime = useMemo(() => ({files: owner?.files ?? new WritingFileSessions(), initialOpenPaths: [...options.initialOpenPaths]}),
    [identity, manuscriptId, options.gateway, checkpointGateway, agentGateways, owner]);
  const [loadedFiles, setLoadedFiles] = useState<typeof lifetime | null>(null);
  const [failedLoad, setFailedLoad] = useState<{files: WritingFileSessions; cause: unknown; retryable: boolean} | null>(null);
  const loadRetry = useRef<{files: WritingFileSessions; resume: () => void} | null>(null);
  const [saveStates, setSaveStates] = useState<Readonly<Record<string, SaveState>>>({});
  const [activePath, setActivePath] = useState<string | undefined>(lifetime.initialOpenPaths[0]);
  const [openPaths, setOpenPaths] = useState<readonly string[]>(lifetime.initialOpenPaths);
  const [fileList, setFileList] = useState<readonly ManuscriptFile[]>([]);
  const [content, setContent] = useState("");
  const [contentHash, setContentHash] = useState<string>();
  const [error, setError] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [, setPendingRecovery] = useState<RecoveryDraft>();
  const [editorPort, setEditorPort] = useState<AgentEditorSessionPort | null>(null);
  const [applicationBusy, setApplicationBusy] = useState(false);
  const activeApplication = useRef(false);
  const observeApplicationBusy = useCallback((busy: boolean) => {activeApplication.current = busy; setApplicationBusy(busy);}, []);
  const files = lifetime.files;
  const latestFiles = useRef(files); latestFiles.current = files;
  useSyncExternalStore(files.subscribe, files.getRevision);
  const ready = loadedFiles === lifetime;
  const access = useMemo(() => owner?.access ?? createExclusiveWritingGateway(options.gateway), [identity, manuscriptId, options.gateway, owner]);
  const gateway = access.gateway;
  const { checkpoints, saves } = useWritingDocumentPersistence(files, gateway, checkpointGateway, owner);
  const conflict = useWritingFileConflict({ fileSessions: files, gateway,
    setActivePath, setContent, setContentHash, setError, setFiles: setFileList, setOpenPaths, setSaveState });
  const loadFile = useWritingFileLoader({ manuscriptId, gateway, fileSessions: files, checkpoints,
    canOpen: () => ready && !applicationBusy && !options.admissionsBlocked && !access.isExclusive(), onFileConflict: conflict.onConflict,
    setActivePath, setOpenPaths, setContent, setContentHash, setSaveState, setError, setPendingRecovery });
  useEffect(() => { if (error) notify.error(error); }, [error]);
  const active = activePath ? files.get({ manuscriptId, relativePath: activePath }) : undefined;
  const persistCurrent = useWritingPersistence({ activeManuscriptId: ready ? manuscriptId : undefined, activePath,
    content: active?.read().content ?? content, contentHash, cursorOffsets: {}, gateway, fileSessions: files, checkpoints,
    fileSaves: saves, openPaths, layoutState: {}, onFileConflict: conflict.onConflict, saveState,
    ...(options.persistWorkspaceSession === undefined ? {} : {persistWorkspaceSession: options.persistWorkspaceSession}),
    setContentHash, setError, setFiles: setFileList, setSaveState });
  useWritingCloseBoundary({ activePath, saveCurrent: persistCurrent, persistCurrent, fileSaves: saves, checkpoints });
  const editorReady = ready && editorPort !== null && editorPort === active?.applicationPort;
  const sharedApplications = useWritingProjectFiles(manuscriptId);
  const applicationHost = {persistence: persistCurrent, onFileConflict: conflict.onConflict, fileSaves: saves,
    ready: ready && !applicationBusy && !conflict.conflict, onBusyChange: observeApplicationBusy,
    ...(options.admissionsBlocked === undefined ? {} : {admissionsBlocked: options.admissionsBlocked}),
    readHost: () => ({manuscriptId, activePath, port: active?.applicationPort ?? null, ready: ready && !conflict.conflict}),
    publishMetadata: (metadata: import("../agent/useWritingProposalApplication").WritingApplicationMetadata) => setFileList(metadata.files)};
  useWritingFileApplicationHost(manuscriptId, applicationHost);
  const localApplications = useWritingFileApplications({ access, observeOnly: owner !== null, persistence: persistCurrent,
    onFileConflict: conflict.onConflict,
    manuscriptId, files, checkpoints, fileSaves: saves, ...(agentGateways ? {agentGateways} : {}),
    ready: ready && !applicationBusy && !conflict.conflict, onBusyChange: observeApplicationBusy,
    ...(options.admissionsBlocked === undefined ? {} : {admissionsBlocked: options.admissionsBlocked}),
    // The file session remains authoritative without an attached EditorView.
    readHost: () => ({ manuscriptId, activePath, port: active?.applicationPort ?? null, ready: ready && !conflict.conflict }),
    publishMetadata: (metadata) => setFileList(metadata.files) });
  const {applicationActions, agentDelivery, undoProposal, undoRecovery, recoveryFeedback} = sharedApplications ?? localApplications;
  useEffect(() => saves.subscribe((event) => {
    setSaveStates((current) => ({ ...current, [event.relativePath]: event.state }));
    const session = files.get(event);
    if (event.state === "error" && errorCode(event.reason) === "file_conflict" && session && event.relativePath !== activePath) handleWritingSaveFailure(event.reason,
      { ...event, bufferedContent: session.read().content }, conflict.onConflict, setError);
  }), [saves, files, activePath, conflict.onConflict]);
  useEffect(() => {
    let current = true;
    let cancelWait: (() => void) | undefined;
    setLoadedFiles(null); setSaveStates({}); setError(undefined); setEditorPort(null);
    setFailedLoad(null);
    setOpenPaths(lifetime.initialOpenPaths); setContent(""); setContentHash(undefined);
    conflict.keepEditing();
    const stopped = Symbol("writing-document-load-stopped");
    const wait = (): Promise<boolean> => new Promise(resolve => {
      const finish = (retry: boolean): void => {
        if (cancelWait === cancel) cancelWait = undefined;
        if (loadRetry.current?.resume === resume) loadRetry.current = null;
        resolve(retry);
      };
      const cancel = (): void => finish(false);
      const resume = (): void => finish(true);
      cancelWait = cancel;
      loadRetry.current = {files, resume};
    });
    // Retry only file reads, never checkpoint recovery. Resume the exact failed
    // read after an explicit retry so completed editor sessions are untouched.
    async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
      for (;;) {
        if (!current) throw stopped;
        try { return await read(); }
        catch (cause: unknown) {
          if (!current) throw stopped;
          setFailedLoad({files, cause, retryable: true});
          if (!await wait()) throw stopped;
          if (!current) throw stopped;
          setFailedLoad(null);
        }
      }
    }
    void (async () => {
      const entries = await readWithRetry(() => gateway.listFiles(manuscriptId));
      if (!current) return;
      setFileList(entries);
      const sources = entries.filter(file => isWritingSourcePath(file.relativePath)
        && lifetime.initialOpenPaths.includes(file.relativePath));
      setOpenPaths(sources.map((file) => file.relativePath));
      setActivePath(path => sources.some(file => file.relativePath === path) ? path : sources[0]?.relativePath);
      for (const entry of sources) {
        const disk = await readWithRetry(() => gateway.readFile(manuscriptId, entry.relativePath));
        if (!current) return;
        try { await checkpoints.open(manuscriptId, disk); }
        catch (reason: unknown) {
          const session = files.get({ manuscriptId, relativePath: entry.relativePath });
          if (!current) return;
          if (!session || errorCode(reason) !== "file_conflict") throw reason;
          handleWritingSaveFailure(reason, { manuscriptId, relativePath: entry.relativePath, bufferedContent: session.read().content }, conflict.onConflict, setError);
        }
        if (!current) return;
      }
      setLoadedFiles(lifetime);
    })().catch((reason: unknown) => { if (current) setFailedLoad({files, cause: reason, retryable: false}); });
    return () => { current = false; cancelWait?.(); };
  }, [lifetime, files, checkpoints, gateway, manuscriptId, conflict.keepEditing, conflict.onConflict]);
  const fileSaveState = (path: string): SaveState => saveStates[path] ?? (checkpoints.isSaved({manuscriptId, relativePath: path}) ? "saved" : "dirty");
  const navigation = useWritingNavigation({activePath, activeManuscriptId: manuscriptId, openPaths,
    saveState: activePath ? fileSaveState(activePath) : saveState,
    canNavigate: () => latestFiles.current === files && ready && !applicationBusy && !options.admissionsBlocked && !access.isExclusive(),
    saveCurrent: async () => latestFiles.current === files && await persistCurrent() && latestFiles.current === files,
    openFile: path => latestFiles.current === files ? loadFile(path, manuscriptId, () => latestFiles.current === files) : Promise.resolve(undefined),
    setActivePath, setOpenPaths, setContent, setContentHash,
    // This host has one fixed manuscript and exposes only select/close.
    setActiveManuscriptId: () => undefined, setIsLibraryOpen: () => undefined, setFocusRequest: () => undefined});
  const prepareClose = useCallback(async (): Promise<boolean> => {
    if (latestFiles.current !== files || !ready || (owner && !sharedApplications)) return false;
    try {await agentDelivery.flush();}
    catch (reason: unknown) {notify.error(errorMessage(reason)); return false;}
    if (latestFiles.current !== files || activeApplication.current) return false;
    if (isWritingNotePath(activePath) && !await persistCurrent()) return false;
    return prepareWritingClose({saves, checkpoints, flushSession: () => persistCurrent.flushSession?.() ?? Promise.resolve(),
      onRecoverable: () => notify.warning("部分保存尚未完成；完整编辑状态已可靠暂存，重新打开后可继续保存。"),
      onFailure: reason => notify.error(`编辑状态未能可靠暂存，请重试保存或取消关闭：${errorMessage(reason)}`)});
  }, [files, ready, agentDelivery.flush, activePath, persistCurrent, saves, checkpoints, owner, sharedApplications]);
  return { files, ready: ready && (!owner || sharedApplications?.filesReady === true), editorReady: editorReady && (!owner || sharedApplications?.filesReady === true), activePath, openPaths, fileList, content: active?.read().content ?? content, contentHash: active?.savedSha256 ?? contentHash, conflict,
    loadFailure: failedLoad?.files === files ? {cause: failedLoad.cause, retryable: failedLoad.retryable} : null,
    retryLoad: () => {if (loadRetry.current?.files === files) loadRetry.current.resume();},
    applicationBusy, applicationActions, agentDelivery, undoProposal, undoRecovery, recoveryFeedback, prepareClose,
    setEditorPort: (port: AgentEditorSessionPort | null) => {if (latestFiles.current === files) setEditorPort(port);},
    readEditorSnapshot: () => ready && active && activePath ? captureWritingEditor(active.state, `${manuscriptId}:${activePath}`) : null,
    readFileBuffers: () => files.readBuffers(manuscriptId),
    select: async (path: string): Promise<void> => {
      if (latestFiles.current !== files) return;
      await navigation.selectFile(path);
    },
    close: async (path: string): Promise<void> => {if (latestFiles.current === files) await navigation.closeFile(path);},
    onChange: (value: string) => {if (latestFiles.current === files) setContent(value);},
    saveState: fileSaveState,
  };
}
