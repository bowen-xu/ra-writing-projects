import { writingProjectVersionActions } from "./writingProjectVersionActions";
import { useWritingNoteWindows } from "./notes/useWritingNoteWindows";
import { BibliographyManager } from "./citations/BibliographyManager";
import { WritingCitationKeys } from "./citations/WritingCitationKeys";
import {useWritingCitationReconciliation} from "./citations/useWritingCitationReconciliation";
import { readWritingSubmissionBuffers } from "./agent/writingSubmissionSources";
import { useNotificationState } from "@research-assistant/workbench-sdk/feedback";
import { AgentCanvasHost } from "@research-assistant/workbench-sdk/agent-canvas";
import { clearWritingRecoveryDraft } from "./persistence/clearWritingRecoveryDraft";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { BoundConversationList } from "@research-assistant/workbench-sdk/agent-conversations";
import { useWritingAgentHistory } from "./useWritingAgentHistory";
import {
  isWritingNotePath,
  isWritingSourcePath,
  parseManuscriptPath,
  type BibliographyStatus,
  type CitationBinding,
  type Manuscript,
  type ManuscriptFile,
  type ManuscriptDirectory,
  type RecoveryDraft,
  type SynctexSourceLocation,
} from "@research-assistant/writing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEditorSessionPort } from "@research-assistant/core/agent";
import { agentCompileResultGateway, agentMetadataGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { readAgentCompilePdfSource } from "./preview/agentCompilePdfSource";
import { useRequestedManuscript } from "./useRequestedManuscript";
import { useWritingNavigation } from "./useWritingNavigation";
import { type WritingTabMode } from "./tabs/WritingProjectTabs";
import { useWritingWorkspaceTabs } from "./tabs/useWritingWorkspaceTabs";

import { WritingNoteActivity, useWritingNoteActivity } from "./notes/WritingNoteActivity";
import { WritingEditorPane } from "./editor/WritingEditorPane";
import {WritingFileRuntimeProvider, useOptionalWritingFileRuntime, useWritingFileRuntime, useWritingFileApplicationHost, useWritingProjectFiles} from "./persistence/WritingFileRuntimeProvider";
import { useWritingCloseBoundary } from "./persistence/useWritingCloseBoundary";
import { WritingFileConflictDialog } from "./editor/WritingFileConflictDialog";
import { CitationPicker } from "./citations/CitationPicker";
import { ManuscriptExplorer } from "./explorer/ManuscriptExplorer";
import { ManuscriptCreateDialog } from "./explorer/ManuscriptCreateDialog";
import { getManuscriptVersionGateway } from "@research-assistant/workbench-sdk/git-versions";
import { getGitWorktreeGateway } from "@research-assistant/workbench-sdk/git-worktrees";
import {getOptionalLiteratureGateway} from "@research-assistant/workbench-sdk/domain-capabilities";
import { CompilePanel } from "./preview/CompilePanel";
import { readCompilePreferences } from "./compilePreferences";
import { useWritingFileLoader } from "./useWritingFileLoader";
import { useWritingFileMetadataSync } from "./useWritingFileMetadataSync";
import { useWritingPersistence } from "./useWritingPersistence";
import { useWritingLayout } from "./useWritingLayout";
import { errorMessage, type SaveState } from "./workspaceState";
import { WritingFeedback } from "./WritingFeedback";
import { WritingToolbar } from "./WritingToolbar";
import { WritingPaneTabs } from "./WritingPaneTabs";
import { useManuscriptTreeActions } from "./useManuscriptTreeActions";
import { useWritingCompiler } from "./useWritingCompiler";
import { WritingCommandPalette } from "./WritingCommandPalette";
import { useWritingFileConflict } from "./useWritingFileConflict";
import { createWritingCommands } from "./writingCommands";
import { ManuscriptLibrary } from "./explorer/ManuscriptLibrary";
import { ManuscriptTransferActions } from "./transfer/ManuscriptTransferActions";
import { WritingSettings } from "./WritingSettings";
import { useEditorPreferences } from "./editor/editorPreferences";
import { WritingDivider } from "./WritingDivider";
import { WritingAgentRuntimePanel } from "./WritingAgentRuntimePanel";
import { useWritingSynctex } from "./useWritingSynctex";
import { handleWritingLayoutShortcut } from "./writingLayoutShortcuts";
import { useWritingSourceIndex } from "./useWritingSourceIndex";
import { useWritingManuscriptLoader } from "./useWritingManuscriptLoader";
import {useWritingWorkspaceSession} from "./useWritingWorkspaceSession";
import { useWritingCitations } from "./useWritingCitations";
import { useWritingAgentPreview } from "./useWritingAgentPreview";
import "./WritingWorkspace.css";
import { useAgentContextCandidate } from "@research-assistant/workbench-sdk/agent-context";
import "./WritingWorkbench.css";
import "./WritingLayout.css";
import "./preview/PreviewToolbar.css";

import { useWritingSourceNavigation } from "./useWritingSourceNavigation";
import type { WritingFocusRequest } from "./sourceNavigation";
interface WritingWorkspaceProps {
  readonly sourceNavigation?: import("@research-assistant/workbench-sdk/source-navigation").WritingSourceNavigation | undefined;
  readonly tabHost?: HTMLElement | null;
  readonly tabsActive?: boolean;
  readonly onOperationBusyChange?: (busy: boolean) => void;
  readonly openManuscriptId: string | undefined;
  readonly openManuscriptRequestKey?: number;
  readonly onManuscriptOpened: () => void;
  readonly onManuscriptOpenFailed?: (id: string, requestKey: number | undefined, message?: string) => void;
  readonly isManuscriptRequestCurrent?: (id: string, requestKey: number | undefined) => boolean;
  readonly onFocusModeChange?: (focused: boolean) => void;
  readonly onEditorVisibilityChange?: (isVisible: boolean) => void;
}

export function WritingWorkspace(props: WritingWorkspaceProps): React.JSX.Element {
  const owner = useOptionalWritingFileRuntime();
  return owner ? <WritingWorkspaceContent {...props}/> : <WritingFileRuntimeProvider><WritingWorkspaceContent {...props}/></WritingFileRuntimeProvider>;
}
function WritingWorkspaceContent({ openManuscriptId, openManuscriptRequestKey, onManuscriptOpened, onManuscriptOpenFailed, isManuscriptRequestCurrent, onEditorVisibilityChange, onFocusModeChange, onOperationBusyChange, tabHost, tabsActive = true, sourceNavigation }: WritingWorkspaceProps): React.JSX.Element {
  const fileRuntime = useWritingFileRuntime(), gatewayAccess = fileRuntime.access;
  const gateway = gatewayAccess.gateway;
  const gitVersionGateway = useMemo(() => getManuscriptVersionGateway(), []);
  const gitWorktreeGateway = useMemo(() => getGitWorktreeGateway(), []);
  const literatureGateway = getOptionalLiteratureGateway();
  const [manuscripts, setManuscripts] = useState<readonly Manuscript[]>([]);
  const layout = useWritingLayout();
  const {activeManuscriptId,setActiveManuscriptId,projectTabs,isLibraryOpen,setIsLibraryOpen,catalogReady,setCatalogReady} = useWritingWorkspaceSession(openManuscriptId,layout,onEditorVisibilityChange,onFocusModeChange,tabsActive);
  // Selection changes before the loader effect can clear the previous metadata.
  const [loadedManuscriptId, setLoadedManuscriptId] = useState<string>();
  const metadataReady = activeManuscriptId !== undefined && loadedManuscriptId === activeManuscriptId;
  const [files, setFiles] = useState<readonly ManuscriptFile[]>([]);
  const [directories, setDirectories] = useState<readonly ManuscriptDirectory[]>([]);
  const [openPaths, setOpenPaths] = useState<readonly string[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [content, setContent] = useState("");
  const fileSessions = fileRuntime.files;
  const tabOpen = useRef<(project: string, path: string, mode: WritingTabMode) => (() => void) | undefined>(undefined);
  const [applicationBusy, setApplicationBusy] = useState(false);
  const [citationKeysBusy,setCitationKeysBusy] = useState(false);
  const editorPort = useRef<AgentEditorSessionPort | null>(null);
  const [contentHash, setContentHash] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [, setError] = useNotificationState();
  const { checkpoints, saves: fileSaves } = fileRuntime;
  const citationKeys = useMemo(() => new WritingCitationKeys(gatewayAccess,fileSessions,checkpoints,fileSaves,setCitationKeysBusy),[gatewayAccess,fileSessions,checkpoints,fileSaves]);
  const [focusRequest, setFocusRequest] = useState<WritingFocusRequest & { readonly path: string }>();
  const [insertionRequest, setInsertionRequest] = useState<{ readonly text: string; readonly token: number }>();
  const [isCitationPickerOpen, setIsCitationPickerOpen] = useState(false);
  const [citationBindings, setCitationBindings] = useState<readonly CitationBinding[]>([]);
  const [bibliographyOpen,setBibliographyOpen] = useState(false);
  const [bibliographyStatus, setBibliographyStatus] = useState<BibliographyStatus>();
  const [pendingRecovery, setPendingRecovery] = useState<RecoveryDraft>();
  const [cursorOffsets, setCursorOffsets] = useState<Readonly<Record<string, number>>>({});
  const [autoCompile, setAutoCompile] = useState(false);
  const [compilePreferences, setCompilePreferences] = useState(() => readCompilePreferences(undefined));
  const [hasCodeCheckErrors, setHasCodeCheckErrors] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const agentHistory = useWritingAgentHistory(activeManuscriptId);
  const [agentConversationListRefresh, setAgentConversationListRefresh] = useState(0);
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  function openCommands(returnFocus?: HTMLElement): void {
    commandReturnFocus.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setIsCommandPaletteOpen(true);
  }
  const [settingsTab, setSettingsTab] = useState<"editor" | "compiler">();
  const editorPreferences = useEditorPreferences();
  const { managedKeys, citationReferences, citationUsage, latexLabels, outline } = useWritingSourceIndex({ enabled: metadataReady && tabsActive && !isLibraryOpen && !isLoading && !applicationBusy && !citationKeysBusy, metadataReady, activeManuscriptId, activePath, content, savedContentHash: contentHash, files, citationBindings, gateway, literatureGateway, bibliographyStatus, onBibliographyChanged: () => compiler.markSourceChanged(), setError, setBibliographyStatus, setFiles, setContent, setContentHash });

  const activeManuscript = manuscripts.find((item) => item.id === activeManuscriptId);
  useAgentContextCandidate(activeManuscript?.status === "active" && !isLibraryOpen
    ? {resource:{kind:"manuscript",resourceId:activeManuscript.id,parts:[]},label:activeManuscript.title} : null,tabsActive);
  const completionData = useMemo(() => ({
    citationKeys: [...new Set([...managedKeys,...citationBindings.map((binding) => binding.citationKey)])],
    files: files.filter((file) => isWritingSourcePath(file.relativePath)).map((file) => file.relativePath),
    labels: latexLabels,
    citationReferences,
  }), [managedKeys, citationBindings, files, latexLabels, citationReferences]);
  const sessionPreferences = useMemo(() => ({
    ...layout.persistenceState,
    autoCompile,
    compilePreferences,
  }), [autoCompile, compilePreferences, layout.persistenceState]);
  const fileConflict = useWritingFileConflict({
    gateway,
    fileSessions,
    setActivePath,
    setContent,
    setContentHash,
    setError,
    setFiles,
    setOpenPaths,
    setSaveState,
  });
  const persistCurrent = useWritingPersistence({
    activeManuscriptId,
    activePath,
    content,
    contentHash,
    fileSessions,
    checkpoints,
    fileSaves,
    cursorOffsets,
    gateway,
    layoutState: sessionPreferences,
    onFileConflict: fileConflict.onConflict,
    openPaths,
    saveState,
    setContentHash,
    setError,
    setFiles,
    setSaveState,
  });
  const { activity: noteActivity, saveCurrent:saveCurrentFile } = useWritingNoteActivity(persistCurrent, setError);
  const saveCurrent = useCallback(async () => {
    if (!await saveCurrentFile()) return false;
    try {
      if (activeManuscriptId) await citationKeys.reconcile(activeManuscriptId);
      await persistCurrent.flushSession?.();
      return true;
    } catch (reason) {setError(errorMessage(reason));return false;}
  },[saveCurrentFile,activeManuscriptId,citationKeys,setError,persistCurrent]);
  useWritingCloseBoundary({ activePath, saveCurrent, persistCurrent, fileSaves, checkpoints });
  const compiler = useWritingCompiler({
    compilePreferences,
    autoCompile,
    gateway,
    manuscriptId: activeManuscriptId,
    saveCurrent,
    saveState,
    setError,
    hasCodeCheckErrors,
  });
  const fileApplications = useWritingProjectFiles(activeManuscriptId);
  const agentDelivery = fileApplications?.agentDelivery, undoProposal = fileApplications?.undoProposal, recoveryFeedback = fileApplications?.recoveryFeedback;
  useWritingFileApplicationHost(isLibraryOpen ? undefined : activeManuscriptId, {persistence: persistCurrent,
    onFileConflict: fileConflict.onConflict,
    ready: metadataReady && !!activeManuscript && !applicationBusy && !isLoading && !isLibraryOpen && !compiler.isCompiling && !pendingRecovery && !fileConflict.conflict,
    onBusyChange: (busy) => { setApplicationBusy(busy); onOperationBusyChange?.(busy); },
    fileSaves,
    readHost: () => ({manuscriptId: activeManuscriptId, activePath, port: editorPort.current,
      ready: metadataReady && !!activeManuscript && !isLoading && !isLibraryOpen && !compiler.isCompiling && !pendingRecovery && !fileConflict.conflict}),
    publishMetadata: (metadata) => {
      setFiles(metadata.files); setDirectories(metadata.directories); setCitationBindings(metadata.citations);
      setBibliographyStatus(metadata.bibliography); setManuscripts(metadata.manuscripts);
      setOpenPaths(paths => paths.filter(path => path === activePath || metadata.files.some(file => file.relativePath === path)));
      compiler.markSourceChanged();
    },
  });

  useEffect(() => { setHasCodeCheckErrors(false); }, [activeManuscriptId, activePath]);
  useRequestedManuscript({requestId: openManuscriptId, ...(openManuscriptRequestKey === undefined ? {} : {requestKey: openManuscriptRequestKey}), access: gatewayAccess, saveCurrent,
    onOpen: (id, items) => {setManuscripts(items);setActiveManuscriptId(id);setIsLibraryOpen(false);},
    onConsumed: onManuscriptOpened, onError: setError,
    ...(isManuscriptRequestCurrent && openManuscriptId ? {isCurrent: () => isManuscriptRequestCurrent(openManuscriptId, openManuscriptRequestKey)} : {}),
    ...(onManuscriptOpenFailed && openManuscriptId ? {onFailure: (message?: string) => onManuscriptOpenFailed(openManuscriptId, openManuscriptRequestKey, message)} : {})});

  const openFile = useWritingFileLoader({ canOpen: () => !gatewayAccess.isExclusive(), manuscriptId: activeManuscriptId, gateway, fileSessions, checkpoints, files, openPaths, activePath: metadataReady ? activePath : undefined,
    content, contentHash, saveState, retainedPaths: id => projectTabs.get(id)?.openPaths,
    onFileConflict: fileConflict.onConflict, setActivePath, setOpenPaths, setContent, setContentHash, setSaveState, setError, setPendingRecovery });
  useWritingFileMetadataSync({manuscriptId: activeManuscriptId, gateway, canRead: () => metadataReady && !gatewayAccess.isExclusive(), onFiles: setFiles,
    onError: reason => setError(errorMessage(reason))});

  useWritingManuscriptLoader({ onCatalogReady:setCatalogReady, tabs: projectTabs, activeManuscript, setLoadedManuscriptId, gateway, checkpoints, openFile, layout,
    setManuscripts, setActiveManuscriptId, setFiles, setDirectories, setOpenPaths,
    setActivePath, setContent, setContentHash, setSaveState, setIsLoading, setError, setCitationBindings,
    setBibliographyStatus, setCursorOffsets, setAutoCompile, setCompilePreferences, setPendingRecovery });

  const {selectFile, closeFile, selectManuscript, openDiagnostic} = useWritingNavigation({
    prepareTabOpen: (project, path, mode) => tabOpen.current?.(project, path, mode),
    activePath, activeManuscriptId, openPaths, saveState, saveCurrent, openFile,
    canNavigate: () => !gatewayAccess.isExclusive(), setActivePath, setActiveManuscriptId,
    setOpenPaths, setContent, setContentHash, setIsLibraryOpen, setFocusRequest,
  });
  const workspaceTabs = useWritingWorkspaceTabs({ store: projectTabs, catalogReady, manuscripts, manuscriptId: activeManuscriptId,
    activePath, openPaths, cursorState: cursorOffsets, layoutState: sessionPreferences,
    ready: metadataReady && !isLoading && files.length > 0 && files.every(file => file.manuscriptId === activeManuscriptId),
    active: tabsActive, home: isLibraryOpen, saveState, files: fileSessions, saves: fileSaves,
    canNavigate: () => !gatewayAccess.isExclusive(), selectProject: selectManuscript, selectFile, closeFile, setOpenPaths,
    onHome: () => { void openManuscriptLibrary(); }, showEditor: () => setIsLibraryOpen(false) });
  tabOpen.current = workspaceTabs.prepareOpen;
  const documentOnly = isWritingNotePath(activePath); const noteWindows = useWritingNoteWindows({ gateway, manuscriptId: activeManuscriptId, activePath, rootPath: activeManuscript?.rootPath, openPaths,
    selectFile, closeFile, setFiles });
  useWritingSourceNavigation(sourceNavigation, activeManuscriptId, metadataReady && !isLoading && files.length > 0 && files.every(file => file.manuscriptId === activeManuscriptId), async path => { if (isWritingNotePath(path) && !await noteWindows.prepare(path)) return false; return selectFile(path); }, setFocusRequest);

  const focusSourceLocation = useCallback(async (location: Pick<SynctexSourceLocation, "relativePath" | "line">, isCurrent: () => boolean = () => true): Promise<void> => {
    if (!isCurrent()) return;
    if (location.relativePath !== activePath && !(await saveCurrent())) return;
    if (location.relativePath !== activePath && !(await openFile(location.relativePath, activeManuscriptId, isCurrent))) return;
    if (!isCurrent()) return;
    layout.reveal("editor");
    setFocusRequest({ path: location.relativePath, line: location.line, token: Date.now() });
  }, [activeManuscriptId, activePath, layout, openFile, saveCurrent]);

  const { latestAgentResult, handleAgentInverseSearch, handleAgentForwardSearch, agentDividerSync,
    setAgentPdfVisible, setAgentPdfReadingPosition, agentSyncBusy, setAgentSyncBusy, agentSynctexLocation, setAgentSynctexLocation }
    = useWritingAgentPreview({ projection: agentHistory.conversation.projection, activeManuscriptId, activePath,
      content, cursorOffsets, compiler, layout, focusSourceLocation });

  async function compileFromEditor(): Promise<void> {
    if (compiler.toolchain?.available !== true || compiler.isCompiling) {
      await saveCurrent();
      return;
    }
    await compiler.start();
  }

  const [displayedPdfRevision, setDisplayedPdfRevision] = useState<string>();
  const sync = useWritingSynctex({
    displayedPdfRevision,
    manuscriptId: activeManuscriptId, run: compiler.pdfRun, toolchain: compiler.toolchain,
    stale: compiler.isPdfStale, hasPdf: compiler.pdfBytes !== undefined, enabled: !isLibraryOpen,
    activePath: isWritingNotePath(activePath) ? undefined : activePath, content, cursorOffset: activePath ? cursorOffsets[activePath] ?? 0 : 0, gateway,
    onPdf: () => layout.reveal("preview"), onError: setError,
    onSource: focusSourceLocation,
  });

  async function createManuscript(title: string): Promise<void> {
    setError(undefined);
    try {
      const created = await gateway.createManuscript({ title });
      setManuscripts((current) => [created, ...current]);
      setIsCreating(false);
      if (!gatewayAccess.isExclusive()) {
        setActiveManuscriptId(created.id);
        setIsLibraryOpen(false);
      }
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    }
  }

  const { searchCitations, bindCitation, insertCitations, resolveBibliographyConflict } = useWritingCitations({ activeManuscriptId,
    activePath, gateway, literatureGateway, citationBindings, compiler, setCitationBindings,
    setBibliographyStatus, setFiles, setInsertionRequest, setError,
    reconcileCitationKeys: (id,pending) => citationKeys.reconcile(id,pending) });

  useWritingCitationReconciliation({enabled: metadataReady && !isLibraryOpen && !isLoading && !applicationBusy && saveState === "saved",
    manuscriptId: activeManuscriptId, activePath, files, gateway, citationKeys, fileSessions, setFiles, setCitationBindings,
    setContent, setContentHash, markSourceChanged: compiler.markSourceChanged, setError});

  const treeActions = useManuscriptTreeActions({
    fileSessions,
    activeManuscript,
    activeManuscriptId,
    activePath,
    files,
    gateway,
    openFile: path => isWritingNotePath(path) ? noteWindows.open(path) : openFile(path),
    onSourceChanged: compiler.markSourceChanged,
    saveCurrent,
    saveState,
    setDirectories,
    setError,
    setFiles,
    setManuscripts,
    setOpenPaths,
  });

  const writingCommands = createWritingCommands({
    autoCompile,
    canCompile: activePath !== undefined && compiler.toolchain?.available === true && !compiler.isCompiling,
    canInsertCitation: !!literatureGateway && activePath !== undefined && !isWritingNotePath(activePath) && !/\.bib$/iu.test(activePath),
    canLocatePdf: sync.actions.forwardDisabled === undefined,
    canSave: activePath !== undefined && saveState !== "saved" && saveState !== "saving",
    isCompiling: compiler.isCompiling,
    onCancelCompile: () => void compiler.cancel(),
    onCompile: () => void compiler.start(),
    onInsertCitation: () => setIsCitationPickerOpen(true),
    onLocatePdf: sync.actions.forward,
    onSave: () => void saveCurrent(),
    onToggleAutoCompile: () => setAutoCompile((value) => !value),
  });

  async function updateActiveManuscript(change: { readonly title?: string; readonly rootPath?: string }): Promise<boolean> {
    if (activeManuscriptId === undefined) return false;
    try {
      const updated = await gateway.updateManuscript({
        manuscriptId: activeManuscriptId,
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.rootPath === undefined ? {} : { rootPath: parseManuscriptPath(change.rootPath) }),
      });
      setManuscripts((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (change.rootPath !== undefined) compiler.markSourceChanged();
      return true;
    } catch (reason: unknown) { setError(errorMessage(reason)); return false; }
  }

  async function changeManuscriptStatus(manuscript: Manuscript): Promise<void> {
    if (manuscript.status === "active" && !window.confirm("归档“" + manuscript.title + "”？源码和编译记录会保留。")) return;
    if (manuscript.id === activeManuscriptId && !(await saveCurrent())) return;
    try {
      const updated = manuscript.status === "active" ? await gateway.archiveManuscript(manuscript.id) : await gateway.restoreManuscript(manuscript.id);
      setManuscripts((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason: unknown) { setError(errorMessage(reason)); }
  }

  async function deleteManuscript(manuscript: Manuscript): Promise<void> {
    if (manuscript.id === activeManuscriptId && compiler.isCompiling) throw new Error("请先停止编译，待任务结束后重试");
    if (manuscript.id === activeManuscriptId && !(await saveCurrent())) throw new Error("当前内容尚未保存，请处理后重试");
    if(manuscript.status === "active") { const archived=await gateway.archiveManuscript(manuscript.id); setManuscripts(current=>current.map(item=>item.id===archived.id?archived:item)); } await gateway.deleteManuscript(manuscript.id);
    if (manuscript.id === activeManuscriptId) {
      setActiveManuscriptId(undefined); setActivePath(undefined); setContent("");
      setOpenPaths([]); setPendingRecovery(undefined); setSaveState("saved");
    }
    setManuscripts((current) => current.filter((item) => item.id !== manuscript.id));
    notify.success("已永久删除“" + manuscript.title + "”");
  }

  function transferActions(importOnly = false, variant: "all" | "imports" | "exports" = "all"): React.JSX.Element {
    return <ManuscriptTransferActions variant={variant} importOnly={importOnly} activeManuscript={activeManuscript} gateway={gateway} hasPdf={compiler.pdfBytes !== undefined}
      onError={setError} beforeExport={saveCurrent}
      onImported={(manuscript) => { setManuscripts((current) => [manuscript, ...current]); if (!gatewayAccess.isExclusive()) {setActiveManuscriptId(manuscript.id); setIsLibraryOpen(false);} }}
      onResourcesImported={() => { void treeActions.refreshTree().then(compiler.markSourceChanged).catch((reason: unknown) => setError(errorMessage(reason))); }} />;
  }

  async function openManuscriptLibrary(): Promise<void> {
    if (gatewayAccess.isExclusive()) return;
    try {
      if (!(await saveCurrent()) || gatewayAccess.isExclusive()) return;
      setIsLibraryOpen(true);
      setManuscripts(await gateway.listManuscripts());
    } catch (reason) { setError(errorMessage(reason)); }
  }

  return (
    <WritingNoteActivity.Provider value={noteActivity}><section className="writing-workspace" data-presentation={documentOnly ? "document" : "workspace"}>
      {isCreating && (
        <ManuscriptCreateDialog
          canCancel={true}
          onCancel={() => setIsCreating(false)}
          onCreate={createManuscript}
        />
      )}
      {!isLibraryOpen && tabsActive && <WritingFeedback
        manuscriptId={activeManuscriptId}
        bibliographyStatus={bibliographyStatus}
        citationUsage={citationUsage}
        onDiscardRecovery={(draft) => { void clearWritingRecoveryDraft(fileSessions, draft, "discard-recovery", () => gateway.clearRecoveryDraft(draft.manuscriptId, draft.relativePath)); setPendingRecovery(undefined); }}
        onResolveBibliography={(preserve) => void resolveBibliographyConflict(preserve)}
        onRestoreRecovery={(draft) => { setContent(draft.content); setSaveState("dirty"); setPendingRecovery(undefined); }}
        pendingRecovery={pendingRecovery}
      />}
      {isLibraryOpen && <ManuscriptLibrary operations={{gateway,beforeAction:async item=>item.id!==activeManuscriptId||await saveCurrent(),onDuplicated:item=>setManuscripts(current=>[item,...current])}} onDelete={deleteManuscript} manuscripts={manuscripts} isLoading={isLoading} onOpen={(id) => void selectManuscript(id)} onCreate={() => setIsCreating(true)} onStatusChange={(manuscript) => void changeManuscriptStatus(manuscript)} transferActions={transferActions(true)} />}
      <div className="writing-workbench" hidden={isLibraryOpen} data-focused={layout.focused} onKeyDownCapture={(event) => handleWritingLayoutShortcut(event, layout.setViewMode, layout.toggleFocus)}>
      {bibliographyOpen && activeManuscriptId && <BibliographyManager key={activeManuscriptId} manuscriptId={activeManuscriptId} gateway={gateway} literature={literatureGateway}
        onBeforeCleanup={async () => {if (fileSaves) {const failures=await fileSaves.flushAll();if(failures.length)throw new Error("稿件尚未保存，未清理参考文献。");} else if (!(await saveCurrent())) throw new Error("稿件尚未保存，未清理参考文献。");}}
        onClose={() => setBibliographyOpen(false)} onInsert={key => {void (async () => {if (!activePath?.toLowerCase().endsWith(".tex") && activeManuscript && !(await selectFile(activeManuscript.rootPath))) return;setInsertionRequest({text:`\\cite{${key}}`,token:Date.now()});setBibliographyOpen(false);})().catch(reason=>notify.error(errorMessage(reason)));}}
        onChanged={async () => {if (activePath && /\.bib$/iu.test(activePath)) await openFile(activePath);setFiles(await gateway.listFiles(activeManuscriptId));setCitationBindings(await gateway.listCitationBindings(activeManuscriptId));setBibliographyStatus(await gateway.getBibliographyStatus(activeManuscriptId));compiler.markSourceChanged();}} />}
      <WritingToolbar activeManuscript={activeManuscript} saveState={saveState} recoveryActions={isLibraryOpen ? undefined : recoveryFeedback}
        onBibliography={() => setBibliographyOpen(true)}
        onSave={() => void saveCurrent()} onOpenCommands={openCommands} onSettings={() => setSettingsTab("editor")}
        onRename={(title) => updateActiveManuscript({ title })} projectActions={transferActions(false, "exports")} viewMode={layout.preferences.viewMode} onViewModeChange={layout.setViewMode}
        activeFilePath={activePath} onReadVersionFile={activeManuscriptId ? async (revision, relativePath) => gitVersionGateway.readFile(activeManuscriptId, revision, relativePath) : undefined}
        onRestoreVersion={activeManuscriptId && agentHistory.selectedId ? async (revision) => {
          try {
            const scope = await gitVersionGateway.latestRestoreScope(agentHistory.selectedId!, activeManuscriptId);
            if (!scope) throw new Error("当前对话没有可恢复的 Agent workspace，请先提交一次需要文件修改的任务");
            const proposal = await gitVersionGateway.restoreVersion(scope, revision);
            notify.success(`已生成 ${proposal.changeCount} 个待审变更`);
          } catch (reason) { notify.error(errorMessage(reason)); throw reason; }
        } : undefined}
        focused={layout.focused} onToggleFocus={layout.toggleFocus} transferActions={transferActions(false, "imports")}
        {...writingProjectVersionActions(activeManuscriptId, gitVersionGateway, gitWorktreeGateway)} />
      <WritingPaneTabs active={layout.preferences.narrowPane} onSelect={layout.selectNarrowPane} />
      <div className="writing-grid" data-narrow-pane={layout.preferences.narrowPane} data-view-mode={layout.preferences.viewMode} data-explorer-visible={layout.preferences.explorerVisible && !layout.focused} data-focused={layout.focused} style={documentOnly ? { ...layout.gridStyle, gridTemplateColumns: "minmax(0, 1fr)" } : layout.gridStyle}>
        <ManuscriptExplorer
          manuscriptId={activeManuscriptId}
          activeNotePath={noteWindows.activePath}
          activePath={activePath}
          files={files}
          directories={directories}
          onCreateFile={(path) => void treeActions.createFile(path)}
          onCreateDirectory={(path) => void treeActions.createDirectory(path)}
          onDeleteDirectory={(path) => void noteWindows.prepare(path).then(ready => { if (ready) return treeActions.deleteDirectory(path); })}
          onDeleteFile={(path) => void noteWindows.prepare(path).then(ready => { if (ready) return treeActions.deleteFile(path); })}
          onRenameFile={(fromPath, toPath) => void noteWindows.prepare(fromPath).then(ready => { if (ready) return treeActions.renameFile(fromPath, toPath); })}
          onRenameDirectory={(fromPath, toPath) => void noteWindows.prepare(fromPath).then(ready => { if (ready) return treeActions.renameDirectory(fromPath, toPath); })}
          onSetRoot={(path) => void updateActiveManuscript({ rootPath: path })}
          outline={outline}
          onSelectOutline={(entry) => { if (activePath !== undefined) void openDiagnostic(activePath, entry.line); }}
          rootPath={activeManuscript?.rootPath}
          onSelectFile={path => { void noteWindows.open(path); }}
          onPinFile={path => { void noteWindows.pin(path); }}
        />
        <WritingEditorPane
          managedTabs={workspaceTabs.managed}
          retainedProjects={workspaceTabs.projects}
          previewPath={activeManuscriptId ? projectTabs.get(activeManuscriptId)?.previewPath : undefined}
          onPinPath={path => { if (activeManuscriptId) projectTabs.pin(activeManuscriptId, path); }}
          {...(tabHost === undefined ? {} : { tabHost })}
          tabsActive={tabsActive}
          homeSelected={isLibraryOpen}
          onHome={() => void openManuscriptLibrary()}
          onEditorSessionReady={(port) => { editorPort.current = port; }}
          codeCheckEnabled={compilePreferences.codeCheck}
          hasCodeCheckErrors={hasCodeCheckErrors}
          onCodeCheckResult={setHasCodeCheckErrors}
          preferences={editorPreferences.preferences}
          onInsertCitation={() => setIsCitationPickerOpen(true)}
          {...(!literatureGateway ? {citationDisabledReason: "literature_citations_unavailable：未装配文献插件；已有引用与书目保留。"} : {})}
          syncActions={sync.actions}
          activeManuscriptId={activeManuscriptId}
          activePath={!isLoading && files.every(file => file.manuscriptId === activeManuscriptId) ? activePath : undefined}
          completionData={{...completionData, ...(literatureGateway ? {libraryCitations: {
            search: query => searchCitations(query, "library"),
            bind: bindCitation,
            onError: reason => setError(errorMessage(reason)),
          }} : {})}}
          content={content}
          cursorOffset={activePath === undefined ? undefined : cursorOffsets[activePath]}
          diagnostics={compiler.run?.diagnostics.filter((diagnostic) => diagnostic.file === activePath) ?? []}
          focusRequest={focusRequest}
          insertionRequest={insertionRequest}
          onChange={(value) => { if (activeManuscriptId && activePath) projectTabs.pin(activeManuscriptId, activePath); setContent(value); setSaveState("dirty"); if (!isWritingNotePath(activePath)) compiler.markSourceChanged(); }}
          onClose={(path) => void closeFile(path)}
          onSaveNote={() => void saveCurrent()}
          onRenameNote={(from, to) => void treeActions.renameFile(from, to)}
          onDeleteNote={path => void treeActions.deleteFile(path)}
          onCompile={() => void compileFromEditor()}
          onOpenCommands={openCommands}
          onCursorChange={(offset) => { if (activePath !== undefined) setCursorOffsets((current) => ({ ...current, [activePath]: offset })); }}
          onSelect={(path) => { void selectFile(path, "preview").then(opened => { if (opened) setIsLibraryOpen(false); }); }}
          openPaths={openPaths}
          saveState={saveState}
          fileSessions={fileSessions}
        />
        <aside className="writing-preview-column">
          <CompilePanel
            active={!isLibraryOpen} pdfIdentity={activeManuscriptId && compiler.pdfRun ? { key: activeManuscriptId, revision: compiler.pdfRun.id } : undefined} onDisplayedVersion={setDisplayedPdfRevision}
            compilePreferences={compilePreferences} onCompilePreferencesChange={setCompilePreferences} isCompiling={compiler.isCompiling} onCompileFromScratch={() => void compiler.start(true)}
            autoCompile={autoCompile} onAutoCompileChange={setAutoCompile} isPdfStale={compiler.isPdfStale} syncActions={sync.actions} onReadingPosition={sync.onReadingPosition}
            onCancel={() => void compiler.cancel()}
            onCompile={() => void compiler.start()}
            onOpenDiagnostic={(path, line) => void openDiagnostic(path, line)}
            onInverseSearch={sync.inverse}
            pdfBytes={compiler.pdfBytes}
            run={compiler.run}
            toolchain={compiler.toolchain}
            synctexLocation={sync.location}
            {...(latestAgentResult ? { agentCompileResult: latestAgentResult, loadAgentPdf: (result: import("@research-assistant/core/agent").AgentCompileResult) => readAgentCompilePdfSource(agentCompileResultGateway, result) } : {})}
            {...(latestAgentResult ? { onAgentInverseSearch: handleAgentInverseSearch } : {})}
            onAgentPdfReadingPosition={setAgentPdfReadingPosition}
            onAgentPdfVisibilityChange={setAgentPdfVisible}
            agentSyncBusy={agentSyncBusy}
            onAgentSyncBusyChange={setAgentSyncBusy}
            {...(latestAgentResult ? { onAgentForwardSearch: handleAgentForwardSearch, onAgentLocationChange: setAgentSynctexLocation, agentSynctexLocation } : {})}
          />
        </aside>
        {!layout.focused && <WritingDivider edge="explorer" collapsed={!layout.preferences.explorerVisible} direction={layout.preferences.explorerVisible ? "left" : "right"} label={layout.preferences.explorerVisible ? "收起左栏" : "展开左栏"} width={layout.preferences.explorerWidth} onToggle={layout.toggleExplorer} onResize={(event) => layout.startResize("explorer", event)} onKeyResize={(event) => layout.keyResize("explorer", event)} />}
        <WritingDivider edge="preview" collapsed={layout.preferences.viewMode !== "split"} direction={layout.preferences.viewMode === "editor" ? "left" : "right"} label={layout.preferences.viewMode === "split" ? "收起 PDF" : layout.preferences.viewMode === "editor" ? "展开 PDF" : "展开源码"} width={layout.preferences.previewWidth} onToggle={() => layout.setViewMode(layout.preferences.viewMode === "split" ? "editor" : "split")} onResize={(event) => layout.startResize("preview", event)} onKeyResize={(event) => layout.keyResize("preview", event)} {...(layout.preferences.viewMode === "split" ? { sync: agentDividerSync ?? sync.actions } : {})} />
      </div>
      {activeManuscriptId && <AgentCanvasHost workspaceId={activeManuscriptId} selectedId={agentHistory.selectedId} onSelect={agentHistory.select} onArchive={agentHistory.setArchived} onDeleted={agentHistory.deleted} open={agentHistory.isOpen} onOpenChange={agentHistory.setOpen} onNewConversation={agentHistory.newConversation} conversations={activeManuscriptId ? <BoundConversationList onCreate={agentHistory.newConversation} key={activeManuscriptId} binding={{ kind: "manuscript", resourceId: activeManuscriptId }} pendingConversationId={agentHistory.pendingConversationId} selectedId={agentHistory.selectedId} onSelect={agentHistory.select} onArchiveChange={agentHistory.setArchived} onDeleted={agentHistory.deleted} onRefreshSelected={() => void agentHistory.refreshMetadata()} refreshToken={agentConversationListRefresh} revealConversation={agentHistory.revealedConversation} metadata={agentMetadataGateway} /> : undefined}>
      {controls => <WritingAgentRuntimePanel {...controls}
        {...(undoProposal ? {undoProposal} : {})} {...(agentDelivery ? {onSubmissionAdmitted: agentDelivery.register, fileDeliveries: agentDelivery.entries} : {})}
        fileSessions={fileSessions}
        onJumpToEditor={(path) => void selectFile(path)}
        readEditorSnapshot={() => editorPort.current?.read() ?? null}
        readFileBuffers={() => activeManuscriptId ? readWritingSubmissionBuffers(activeManuscriptId, fileSessions, gatewayAccess.gateway) : []}
        manuscriptId={activeManuscriptId}
        conversationId={agentHistory.selectedId}
        pendingConversationId={agentHistory.pendingConversationId}
        onConversationCreated={(conversation) => { agentHistory.conversationCreated(conversation); setAgentConversationListRefresh((value) => value + 1); }}
        archived={agentHistory.isArchived}
        metadataUnavailable={agentHistory.pendingConversationId ? undefined : agentHistory.metadata.unavailableReason}
        metadataLoading={agentHistory.pendingConversationId ? false : agentHistory.metadata.status === "loading"}
        onRetryMetadata={() => void agentHistory.refreshMetadata()}
        onConversationCreationFinished={agentHistory.newConversation}
        onConversationTitleChanged={() => { void agentHistory.refreshMetadata(); setAgentConversationListRefresh((value) => value + 1); }}
        content={content}
        contentHash={contentHash}
        files={files}
        projection={agentHistory.conversation.projection}
        historyReady={!!agentHistory.pendingConversationId || (agentHistory.conversation.status === "ready" && !isLoading)}
        messages={agentHistory.messages} searchTarget={agentHistory.searchTarget} historyError={!agentHistory.pendingConversationId && agentHistory.conversation.status === "error"} onOpenConversation={agentHistory.openRelatedConversation}
        key={`${activeManuscriptId ?? "no-manuscript"}/${agentHistory.selectedId ?? "no-conversation"}`}
        open={agentHistory.isOpen}
        onOpenChange={agentHistory.setOpen}
        activePath={activePath}
        conversationTitle={agentHistory.metadata.conversation?.title}
      />}
      </AgentCanvasHost>}
      </div>
      {settingsTab !== undefined && activeManuscriptId && <WritingSettings manuscriptId={activeManuscriptId} initialTab={settingsTab} preferences={editorPreferences.preferences} onPreferencesChange={editorPreferences.update}
        files={files} rootPath={activeManuscript?.rootPath} onRootChange={(rootPath) => void updateActiveManuscript({ rootPath })}
        engine={compiler.engine} onEngineChange={compiler.setEngine} toolchain={compiler.toolchain} isCompiling={compiler.isCompiling}
        autoCompile={autoCompile} onAutoCompileChange={setAutoCompile} onClose={() => setSettingsTab(undefined)} />}
      <CitationPicker
        onClose={() => setIsCitationPickerOpen(false)}
        onInsert={insertCitations}
        onSearch={searchCitations}
        open={isCitationPickerOpen}
      />
      {isCommandPaletteOpen && (
        <WritingCommandPalette
          returnFocus={commandReturnFocus.current}
          commands={writingCommands}
          onClose={() => setIsCommandPaletteOpen(false)}
        />
      )}
      {fileConflict.conflict !== undefined && (
        <WritingFileConflictDialog
          manuscriptId={fileConflict.conflict.manuscriptId}
          bufferedContent={fileConflict.conflict.bufferedContent}
          diskContent={fileConflict.conflict.diskFile.content}
          onKeepEditing={fileConflict.keepEditing}
          onReload={fileConflict.reload}
          onSaveAs={async (relativePath) => {
            const saved = await fileConflict.saveAs(relativePath);
            if (saved && !isWritingNotePath(relativePath)) compiler.markSourceChanged();
            return saved;
          }}
          relativePath={fileConflict.conflict.relativePath}
        />
      )}
      {noteWindows.surface}
    </section></WritingNoteActivity.Provider>
  );
}
