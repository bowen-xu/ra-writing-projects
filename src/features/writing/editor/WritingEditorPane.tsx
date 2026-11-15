import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { WritingNoteToolbar } from "../notes/WritingNoteToolbar";
import { isWritingNotePath, writingNoteTitle } from "@research-assistant/writing";
import { WritingNoteSessions } from "../notes/WritingNoteSessions";
import "../notes/WritingNotes.css";
import type { CompileDiagnostic } from "@research-assistant/writing";
import { useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePublishWorkspaceTabs } from "@research-assistant/workbench-sdk/workbench";
import type { WritingFileSessions } from "./writingFileSessions";
import { Bold, Italic, Undo2, Redo2, Search, BookOpen, FileCode2, FileText, House, X } from "lucide-react";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView, Command } from "@codemirror/view";
import { WritingSyncButton, type WritingSyncActions } from "../WritingDivider";
import { LatexEditor } from "./LatexEditor";
import { RetainedLatexEditor } from "./RetainedLatexEditor";
import { toggleWritingStyle } from "./latexEditingCommands";
import type { EditorPreferences } from "./editorPreferences";
import type { LatexCompletionData } from "./extensions/latexCompletion";
import type { SaveState } from "../workspaceState";
import type { AgentEditorSessionPort } from "@research-assistant/core/agent";
import { createWritingEditorSessionPort } from "./editorSessionPort";

interface WritingEditorPaneProps {
  readonly managedTabs?: boolean;
  readonly previewPath?: string | undefined;
  readonly onPinPath?: (path: string) => void;
  readonly retainedProjects?: readonly { readonly manuscriptId: string; readonly openPaths: readonly string[] }[];
  readonly tabHost?: HTMLElement | null;
  readonly tabsActive?: boolean;
  readonly homeSelected?: boolean;
  readonly onHome?: () => void;
  readonly onEditorSessionReady?: (port: AgentEditorSessionPort | null) => void;
  readonly activeManuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly completionData: LatexCompletionData;
  readonly content: string;
  readonly cursorOffset: number | undefined;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly focusRequest: (import("../sourceNavigation").WritingFocusRequest & { readonly path: string }) | undefined;
  readonly insertionRequest: { readonly text: string; readonly token: number } | undefined;
  readonly openPaths: readonly string[];
  readonly saveState: SaveState;
  readonly onChange: (value: string) => void;
  readonly onClose: (path: string) => void;
  readonly onCompile: () => void;
  readonly onSaveNote?: () => void;
  readonly onRenameNote?: (from: string, to: string) => void;
  readonly onDeleteNote?: (path: string) => void;
  readonly onOpenCommands: () => void;
  readonly onCursorChange: (offset: number) => void;
  readonly onSelect: (path: string) => void;
  readonly preferences: EditorPreferences;
  readonly onInsertCitation: () => void;
  readonly citationDisabledReason?: string;
  readonly syncActions: WritingSyncActions;
  readonly codeCheckEnabled: boolean;
  readonly hasCodeCheckErrors: boolean;
  readonly onCodeCheckResult: (hasErrors: boolean) => void;
  readonly fileSessions?: WritingFileSessions;
}

const noSubscription = (): (() => void) => () => undefined;
const zeroRevision = (): number => 0;

export function WritingEditorPane(props: WritingEditorPaneProps): React.JSX.Element {
  const isNote = isWritingNotePath(props.activePath);
  const isBib = /\.bib$/iu.test(props.activePath ?? "");
  useSyncExternalStore(props.fileSessions?.subscribe ?? noSubscription, props.fileSessions?.getRevision ?? zeroRevision);
  // The file loader owns session creation. During a manuscript switch, props
  // can still contain the previous file's text until its loading effect runs.
  const fileSession = props.fileSessions && props.activeManuscriptId && props.activePath && !isNote && !isBib
    ? props.fileSessions.get({ manuscriptId: props.activeManuscriptId, relativePath: props.activePath }) : undefined;
  const viewRef = useRef<EditorView | null>(null);
  const canPresentSource = props.activePath !== undefined && !isNote && (!props.fileSessions || isBib || fileSession !== undefined);
  const retainSource = canPresentSource || props.openPaths.some(path => !isWritingNotePath(path))
    || props.retainedProjects?.some(project => project.openPaths.some(path => !isWritingNotePath(path)));
  const portRef = useRef<ReturnType<typeof createWritingEditorSessionPort> | null>(null);
  function run(command: Command): void {
    const view = viewRef.current;
    if (view !== null) { command(view); view.focus(); }
  }
  const line = props.content.slice(0, props.cursorOffset ?? 0).split("\n").length;
  const pendingDiffPaths = new Set(props.fileSessions?.forManuscript(props.activeManuscriptId ?? "")
    .filter((session) => session.pending).map((session) => session.identity.relativePath));
  const sharedTabs = usePublishWorkspaceTabs("writing", [
    ...(props.onHome ? [{ id: "writing:home", owner: "writing" as const, title: "返回写作项目列表", home: true, active: props.tabsActive !== false && props.homeSelected === true, select: props.onHome }] : []),
    ...props.openPaths.map(path => ({ id: `writing:${props.activeManuscriptId}:${path}`, owner: "writing" as const,
      title: isWritingNotePath(path) ? writingNoteTitle(path) : path.split("/").at(-1) ?? path,
      icon: isWritingNotePath(path) ? "text" as const : "code" as const,
      active: props.tabsActive !== false && !props.homeSelected && path === props.activePath,
      dirty: path === props.activePath && props.saveState === "dirty", pending: pendingDiffPaths.has(path),
      preview: props.previewPath === path, pin: () => props.onPinPath?.(path),
      select: () => props.onSelect(path), close: () => props.onClose(path),
    })),
  ], !props.managedTabs);
  const tabs = (
      <div aria-label="稿件文件标签" className="editor-tabs" hidden={props.tabHost ? props.tabsActive === false : undefined} role="group">
        {props.onHome && <ControlHint content="返回写作项目列表"><button aria-label="返回写作项目列表" aria-pressed={props.homeSelected === true}
          className="workspace-home-button" onClick={props.onHome} type="button"><House aria-hidden="true" size={16} /></button></ControlHint>}
        {props.openPaths.map((path) => (
          <div className={[!props.homeSelected && path === props.activePath ? "active" : "", pendingDiffPaths.has(path) ? "diff-pending" : ""].filter(Boolean).join(" ")} data-preview={props.previewPath === path || undefined} key={path}>
            <ControlHint content={path}><button aria-label={path} onClick={() => props.onSelect(path)} onDoubleClick={() => props.onPinPath?.(path)} type="button">{isWritingNotePath(path) ? <FileText size={15} /> : <FileCode2 size={15} />}{isWritingNotePath(path) ? writingNoteTitle(path) : path.split("/").at(-1)}{path === props.activePath && props.saveState === "dirty" ? " •" : ""}</button></ControlHint>
            <button aria-label={"关闭 " + path} onClick={() => props.onClose(path)} type="button"><X size={13} /></button>
          </div>
        ))}
      </div>
  );
  return (
    <div className="writing-editor-column" data-note={isNote} data-inline-tabs={!props.managedTabs && !sharedTabs && !props.tabHost} data-tabs-docked={Boolean(props.tabHost || sharedTabs || props.managedTabs)}>
      {!props.managedTabs && !sharedTabs && (props.tabHost ? createPortal(tabs, props.tabHost) : tabs)}
      {!isNote && <div className="writing-editor-tools" role="toolbar" aria-label="源码编辑工具">
        <ControlHint content="撤销"><button aria-label="撤销" disabled={!props.activePath || isBib} onMouseDown={(event) => event.preventDefault()} onClick={() => run(undo)} type="button"><Undo2 size={17} /></button></ControlHint>
        <ControlHint content="重做"><button aria-label="重做" disabled={!props.activePath || isBib} onMouseDown={(event) => event.preventDefault()} onClick={() => run(redo)} type="button"><Redo2 size={17} /></button></ControlHint>
        <span className="writing-tool-divider" />
        <ControlHint content="粗体"><button aria-label="粗体" disabled={!props.activePath || isBib} onMouseDown={(event) => event.preventDefault()} onClick={() => run(toggleWritingStyle("textbf"))} type="button"><Bold size={17} /></button></ControlHint>
        <ControlHint content="斜体"><button aria-label="斜体" disabled={!props.activePath || isBib} onMouseDown={(event) => event.preventDefault()} onClick={() => run(toggleWritingStyle("textit"))} type="button"><Italic size={17} /></button></ControlHint>
        <ControlHint content={props.citationDisabledReason ?? "插入文献引用"} wrap><button aria-label="插入引用" aria-description={props.citationDisabledReason} disabled={!props.activePath || isBib || props.citationDisabledReason !== undefined} onMouseDown={(event) => event.preventDefault()} onClick={props.onInsertCitation} type="button"><BookOpen size={17} /></button></ControlHint>
        <span className="writing-tool-spacer" />
        <WritingSyncButton direction="forward" actions={props.syncActions} className="writing-narrow-sync" />
        <ControlHint content="查找替换（Cmd/Ctrl+F）"><button aria-label="查找替换" disabled={!props.activePath} onClick={() => { const view = viewRef.current; if (view) openSearchPanel(view); }} type="button"><Search size={17} /></button></ControlHint>
      </div>}
      {isNote && props.activePath && <WritingNoteToolbar manuscriptId={props.activeManuscriptId ?? ""} path={props.activePath} content={props.content} saveState={props.saveState}
        {...(props.onSaveNote ? { onSave: props.onSaveNote } : {})} {...(props.onRenameNote ? { onRename: props.onRenameNote } : {})} {...(props.onDeleteNote ? { onDelete: props.onDeleteNote } : {})} />}
      <div className="writing-editor-host">
        {props.activePath === undefined && <div className="editor-empty">从左侧选择一个文件或笔记</div>}
        {retainSource && <RetainedLatexEditor visible={props.tabsActive !== false && !props.homeSelected} source={canPresentSource ? <LatexEditor
          {...(fileSession === undefined ? {} : { fileSession })}
          codeCheckEnabled={props.codeCheckEnabled && !isBib}
          onCodeCheckResult={props.onCodeCheckResult}
          preferences={props.preferences}
          onReady={(view) => {
            portRef.current?.dispose();
            viewRef.current = view;
            const documentKey = props.activeManuscriptId + ":" + props.activePath;
            portRef.current = view && !fileSession ? createWritingEditorSessionPort(view, documentKey) : null;
            props.onEditorSessionReady?.(view ? fileSession?.applicationPort ?? portRef.current : null);
          }}
          completionData={props.completionData}
          diagnostics={props.diagnostics}
          documentKey={props.activeManuscriptId + ":" + props.activePath}
          focusRequest={props.focusRequest?.path === props.activePath ? props.focusRequest : undefined}
          {...(props.insertionRequest === undefined ? {} : { insertionRequest: props.insertionRequest })}
          {...(props.cursorOffset === undefined ? {} : { initialCursor: props.cursorOffset })}
          onChange={props.onChange} onCompile={props.onCompile} onOpenCommands={props.onOpenCommands}
          onCursorChange={props.onCursorChange} value={props.content}
        /> : undefined}/>}
        <WritingNoteSessions {...(props.retainedProjects ? { retainedProjects: props.retainedProjects } : {})} manuscriptId={props.activeManuscriptId ?? ""} activePath={props.activePath} content={props.content} openPaths={props.openPaths} onChange={props.onChange} focusRequest={props.focusRequest} />
      </div>
      <footer className="writing-editor-status"><span>{props.activePath ?? "未打开文件"}</span><span>{isNote ? "块笔记" : <>{props.hasCodeCheckErrors ? "Code Check 发现问题 · " : ""}行 {line} · UTF-8 · {props.activePath?.toLowerCase().endsWith(".bib") ? "BibTeX · 受管只读" : "LaTeX"}</>}</span></footer>
    </div>
  );
}
