import { readWritingSubmissionBuffers } from "../../../../../src/features/writing/agent/writingSubmissionSources";
import {SourceHintGatewayProvider} from "@research-assistant/workbench-preview/source-hint-gateways";
import { AgentCanvasShell, AgentCanvasHost } from "@research-assistant/workbench-preview/agent-canvas-shell";
import { DeveloperModeToggle } from "@research-assistant/workbench-preview/developer-mode";
import { LLM_CONFIGURATION_CHANGED_EVENT } from "@research-assistant/workbench-preview/llm-configuration-events";
import { SpeechInputAdapterProvider } from "@research-assistant/workbench-preview/speech-input-adapter";
import { writingDemoSpeechAdapter } from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import type { WritingDemoModelMode } from "@research-assistant/workbench-preview/writing-demo-model-gateway";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WritingAgentRuntimePanel } from "../../../../../src/features/writing/WritingAgentRuntimePanel";
import { useWritingAgentHistory } from "../../../../../src/features/writing/useWritingAgentHistory";
import { AgentDraftProvider } from "@research-assistant/workbench-preview/agent-draft-provider";
import { BoundConversationList } from "@research-assistant/workbench-preview/bound-conversation-list";
import { createWritingDiffDemoRuntime } from "./writingDiffDemoRuntime";
import { WritingEditorPane } from "../../../../../src/features/writing/editor/WritingEditorPane";
import { WritingFileConflictDialog } from "../../../../../src/features/writing/editor/WritingFileConflictDialog";
import { WritingDiffDemoStorage, type WritingDiffDemoFault } from "../../../../agent/WritingDiffDemoStorage";
import { WritingDiffDemoAgentStorage } from "./WritingDiffDemoAgentStorage";
import { useWritingDiffDemoDocuments } from "./useWritingDiffDemoDocuments";
import { AppToaster } from "@research-assistant/workbench-preview/app-toaster";
import type { EditorPreferences } from "../../../../../src/features/writing/editor/editorPreferences";
import { initialChanges, mixedFileChanges, binaryFileChanges } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import "../../../../../src/features/writing/WritingWorkspace.css";
import "../../../../../src/features/writing/WritingWorkbench.css";
import "@research-assistant/workbench-preview/styles/agent-inline-change-summary";
import "../../../../styles/WritingEditorDiffDemo.css";
import { SOURCE_NAVIGATION_PREVIEW_URL } from "@research-assistant/workbench-preview/source-navigation-preview";

const DEMO_SCOPE = {
  conversationId: "00000000-0000-4000-8000-000000000001",
  requestId: "00000000-0000-4000-8000-000000000002",
  manuscriptId: "00000000-0000-4000-8000-000000000003",
  contextSnapshotId: "00000000-0000-4000-8000-000000000004",
} as const;
const DEMO_TURN_ID = "00000000-0000-4000-8000-000000000005";
const editorPreferences: EditorPreferences = { fontSize: 14, lineWrapping: true, showLineNumbers: true, tabSize: 2 };

type FileScenario = "text" | "mixed" | "binary";
function createBackend(scenario: FileScenario = "text", fault: WritingDiffDemoFault = "none") {
  const changes = scenario === "mixed" ? mixedFileChanges : scenario === "binary" ? binaryFileChanges : initialChanges;
  const storage = new WritingDiffDemoStorage(DEMO_SCOPE.manuscriptId, changes);
  storage.fault = fault;
  const agent = new WritingDiffDemoAgentStorage(storage,
    { admission: { scope: DEMO_SCOPE, turnId: DEMO_TURN_ID }, changes });
  agent.failBeforeDispatch = fault === "dispatch";
  agent.failEditorConfirmation = fault === "editorConfirm";
  agent.failDiskConfirmation = fault === "diskConfirm";
  const runtime = createWritingDiffDemoRuntime(storage, agent, DEMO_SCOPE.manuscriptId, DEMO_SCOPE.conversationId);
  return { storage, agent, runtime, scenario };
}
export function WritingEditorDiffDemo(): React.JSX.Element {
  const [backend, setBackend] = useState(createBackend);
  return <SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider key={backend.runtime.identity}><WritingDiffDemoHost backend={backend}
    onReset={() => setBackend(createBackend(backend.scenario))}
    onScenario={scenario => setBackend(createBackend(scenario, backend.storage.fault))} /></AgentDraftProvider></SpeechInputAdapterProvider>;
}
function WritingDiffDemoHost({ backend, onReset, onScenario }: { readonly backend: ReturnType<typeof createBackend>;
  readonly onReset: () => void; readonly onScenario: (scenario: FileScenario) => void }): React.JSX.Element {
  const { storage, agent, runtime } = backend;
  const documents = useWritingDiffDemoDocuments(storage, DEMO_SCOPE.manuscriptId, agent);
  const fileSessions = documents.files;
  const history = useWritingAgentHistory(DEMO_SCOPE.manuscriptId, runtime.history);
  const [modelMode, setModelMode] = useState<WritingDemoModelMode>("default");
  const [composerPreparing, setComposerPreparing] = useState(false);
  const [responseMode, setResponseMode] = useState<"files" | "text">("files");
  const [durationSeconds, setDurationSeconds] = useState(3);
  const [fault, setFault] = useState<WritingDiffDemoFault>(storage.fault);
  useSyncExternalStore(fileSessions.subscribe, fileSessions.getRevision);
  const [cursorOffset, setCursorOffset] = useState(0);
  const [listRefresh, setListRefresh] = useState(0);
  const editorPreviewRef = useRef<HTMLElement>(null);
  const lifecycle = useRef(0);
  useEffect(() => {
    runtime.execution.reschedule(durationSeconds * 1000);
  }, [runtime, durationSeconds]);
  useEffect(() => {
    runtime.execution.singleTextResponse = responseMode === "text" ? "已收到消息。本轮只回复文本，不修改文件。" : undefined;
  }, [runtime, responseMode]);
  useEffect(() => {
    runtime.execution.patchFailure = fault === "tool" ? "persistent" : fault === "toolRetry" ? "once" : undefined;
  }, [runtime, fault]);
  useEffect(() => {
    const generation = ++lifecycle.current, release = runtime.retain();
    history.setOpen(true);
    return () => { release(); queueMicrotask(() => {
      if (lifecycle.current === generation) runtime.dispose();
    }); };
  }, [runtime]);
  const selectedPath = documents.activePath;
  function jumpToEditor(path: string): void {
    void documents.select(path);
    requestAnimationFrame(() => editorPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function refreshConversations(): void { void history.refreshMetadata(); setListRefresh(value => value + 1); }

  return <SourceHintGatewayProvider gateways={runtime.sourceHints}><main className="writing-editor-diff-demo">
    <AppToaster />
    <header className="writing-editor-diff-demo-header"><div><span className="writing-editor-diff-demo-eyebrow">WRITING CANVAS / EDITOR PREVIEW</span><h1>聊天窗内嵌编辑器 Diff</h1><p>使用实际写作页面的聊天窗、编辑器和 Diff 组件展示假数据修改。</p></div></header>
    <section className="writing-editor-diff-demo-chat-host" aria-label="聊天窗内嵌编辑器 Diff 演示"><AgentCanvasShell placement="contained" reconcileEvidence={runtime.reconcileEvidence}><AgentCanvasHost selectedId={history.selectedId} open={history.isOpen} onOpenChange={history.setOpen} onNewConversation={history.newConversation} conversations={<BoundConversationList onCreate={history.newConversation}
      binding={{ kind: "manuscript", resourceId: DEMO_SCOPE.manuscriptId }} selectedId={history.selectedId}
      pendingConversationId={history.pendingConversationId} onSelect={history.select}
      onArchiveChange={history.setArchived} onRefreshSelected={() => void history.refreshMetadata()} refreshToken={listRefresh}
      revealConversation={history.revealedConversation} onDeleted={history.deleted} {...runtime.listGateways} />}>{controls => <WritingAgentRuntimePanel {...controls}
      dismissOnOutsideClick={false} gateways={runtime.gateways} manuscriptId={DEMO_SCOPE.manuscriptId} conversationId={history.selectedId}
      pendingConversationId={history.pendingConversationId} open={history.isOpen} onOpenChange={history.setOpen}
      conversationTitle={history.metadata.conversation?.title} activePath={selectedPath} content={selectedPath ? fileSessions.get({ manuscriptId: DEMO_SCOPE.manuscriptId, relativePath: selectedPath })?.read().content ?? documents.content : ""}
      contentHash={documents.contentHash} files={documents.fileList} messages={history.messages}
      projection={history.conversation.projection} historyReady={!composerPreparing && (!!history.pendingConversationId || (history.conversation.status === "ready" && documents.ready))}
      historyError={!history.pendingConversationId && history.conversation.status === "error"}
      archived={history.isArchived} metadataUnavailable={history.pendingConversationId ? undefined : history.metadata.unavailableReason}
      metadataLoading={history.pendingConversationId ? false : history.metadata.status === "loading"} onRetryMetadata={() => void history.refreshMetadata()}
      onConversationCreated={conversation => { history.conversationCreated(conversation); refreshConversations(); }}
      onConversationTitleChanged={refreshConversations} onOpenConversation={history.openRelatedConversation} searchTarget={history.searchTarget}
      readEditorSnapshot={documents.readEditorSnapshot} readFileBuffers={() => readWritingSubmissionBuffers(DEMO_SCOPE.manuscriptId, fileSessions, storage.files)}
      undoProposal={documents.undoProposal} onSubmissionAdmitted={documents.agentDelivery.register} fileDeliveries={documents.agentDelivery.entries} fileSessions={fileSessions} onJumpToEditor={jumpToEditor}
    />}</AgentCanvasHost></AgentCanvasShell></section>
    <section className="writing-workspace writing-editor-diff-demo-real-editor" aria-label="编辑器 Diff 预览" ref={editorPreviewRef}>
      {documents.recoveryFeedback}
      {documents.ready && <WritingEditorPane activeManuscriptId={DEMO_SCOPE.manuscriptId} activePath={selectedPath} completionData={{ citationKeys: [], files: documents.fileList.map((file) => file.relativePath), labels: [] }} content={selectedPath ? fileSessions.get({ manuscriptId: DEMO_SCOPE.manuscriptId, relativePath: selectedPath })?.read().content ?? documents.content : ""} cursorOffset={cursorOffset} diagnostics={[]} focusRequest={undefined} insertionRequest={undefined} openPaths={documents.openPaths} saveState={documents.saveState(selectedPath ?? "")}
        onEditorSessionReady={documents.setEditorPort} onChange={documents.onChange} onClose={path=>void documents.close(path)} onCompile={() => undefined} onOpenCommands={() => undefined} onCursorChange={setCursorOffset} onSelect={documents.select} preferences={editorPreferences}
        onInsertCitation={() => undefined} syncActions={{ forward: () => undefined, backward: () => undefined, forwardDisabled: undefined, backwardDisabled: undefined }} codeCheckEnabled={false} hasCodeCheckErrors={false} onCodeCheckResult={() => undefined} fileSessions={fileSessions} />}
    </section>
    {documents.conflict.conflict && <WritingFileConflictDialog manuscriptId={documents.conflict.conflict.manuscriptId}
      relativePath={documents.conflict.conflict.relativePath} bufferedContent={documents.conflict.conflict.bufferedContent}
      diskContent={documents.conflict.conflict.diskFile.content} onKeepEditing={documents.conflict.keepEditing}
      onReload={documents.conflict.reload} onSaveAs={documents.conflict.saveAs} />}
    <footer className="writing-editor-diff-demo-note"><a className="writing-editor-diff-demo-reset" href={SOURCE_NAVIGATION_PREVIEW_URL}>来源引用预览</a><button className="writing-editor-diff-demo-reset" type="button" disabled={documents.restarting} onClick={onReset}><RotateCcw size={14} />重置</button>
      <button className="writing-editor-diff-demo-reset" type="button" aria-pressed={composerPreparing}
        onClick={() => setComposerPreparing(value => !value)}>{composerPreparing ? "恢复输入" : "模拟准备中"}</button>
      <button className="writing-editor-diff-demo-reset" type="button" disabled={!documents.ready || documents.restarting} onClick={() => { void documents.restart().then((restarted) => { if (restarted) setCursorOffset(0); }); }}>模拟退出并重开</button>
      <button className="writing-editor-diff-demo-reset" type="button" disabled={!documents.ready || documents.restarting || !selectedPath}
        onClick={() => { if (selectedPath) void storage.externalEdit(selectedPath, "% changed outside editor\n"); }}>模拟外部文件修改</button>
      <div className="writing-editor-diff-demo-selectors">
        <label>下一轮回复<select aria-label="模拟下一轮回复" value={responseMode} onChange={event => setResponseMode(event.target.value as "files" | "text")}><option value="files">修改文件</option><option value="text">只回复文本</option></select></label>
        <label>模拟运行时长（秒）<input aria-label="模拟运行时长（秒）" type="number" min="0.1" step="0.1" value={durationSeconds} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0.1) setDurationSeconds(value); }} /></label>
      <label>模拟故障 <select aria-label="模拟故障" value={fault} disabled={documents.restarting} onChange={(event) => { const value = event.currentTarget.value as WritingDiffDemoFault; storage.fault = value; agent.failBeforeDispatch = value === "dispatch"; agent.failEditorConfirmation = value === "editorConfirm"; agent.failDiskConfirmation = value === "diskConfirm"; setFault(value); }}>
        <option value="none">无</option><option value="tool">修改工具失败（Agent 核对后报告）</option><option value="toolRetry">修改工具首次失败（Agent 重试成功）</option>
        <option value="file">正式保存失败</option><option value="checkpoint">检查点失败</option><option value="both">保存与检查点均失败</option>
        <option value="fileReceipt">下一次正式保存回执丢失</option><option value="checkpointReceipt">下一次检查点回执丢失</option><option value="delayed">延迟存储回执</option>
        <option value="dispatch">文件修改派发前失败</option>
        <option value="editorConfirm">最后文件的编辑器签收日志失败</option>
        <option value="diskConfirm">最后文件的磁盘签收日志失败</option>
      </select></label>
      <label>模拟模型选择 <select aria-label="模拟模型选择" value={modelMode} onChange={event => {
        const value = event.currentTarget.value as WritingDemoModelMode;
        runtime.setModelMode(value); setModelMode(value); window.dispatchEvent(new Event(LLM_CONFIGURATION_CHANGED_EVENT));
      }}><option value="default">默认模型列表</option><option value="openai">OpenAI 推理强度与 Fast mode</option></select></label>
      <label>模拟文件场景 <select aria-label="模拟文件场景" value={backend.scenario} disabled={documents.restarting}
        onChange={event => onScenario(event.currentTarget.value as FileScenario)}>
        <option value="text">已有文本修改</option><option value="mixed">源码修改＋新增／删除文件</option>
        <option value="binary">源码修改＋二进制文件</option>
      </select></label></div><DeveloperModeToggle /></footer>
  </main></SourceHintGatewayProvider>;
}
