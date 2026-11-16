import { useState, type Ref } from "react";
import { WritingEditorPane } from "../../../../../src/features/writing/editor/WritingEditorPane";
import { useEditorPreferences } from "../../../../../src/features/writing/editor/editorPreferences";
import { WritingFileConflictDialog } from "../../../../../src/features/writing/editor/WritingFileConflictDialog";
import type { useWritingDocuments } from "../../../../fixtures/useWritingDocuments";
import "../../../../../src/features/writing/WritingWorkspace.css";
import "../../../../../src/features/writing/WritingWorkbench.css";
import "../../../../styles/NativeCanvasEditor.css";

export function NativeCanvasEditor({ manuscriptId, documents, blocked, hostRef, tabsActive = true, active = true }: {
  readonly manuscriptId: string;
  readonly documents: ReturnType<typeof useWritingDocuments>;
  readonly blocked: boolean;
  readonly hostRef?: Ref<HTMLElement>;
  readonly tabsActive?: boolean;
  readonly active?: boolean;
}): React.JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(0);
  const { preferences } = useEditorPreferences();
  const conflict = documents.conflict.conflict;
  return <>
    <section ref={hostRef} className="agent-canvas-demo-documents" aria-label="稿件文件交付与编辑器" hidden={!tabsActive} inert={blocked}>
      {documents.recoveryFeedback}
      <div className="writing-workspace">
        <div className="writing-grid" data-explorer-visible="false" data-view-mode="editor" data-narrow-pane="editor">
          {documents.ready ? <WritingEditorPane activeManuscriptId={manuscriptId} activePath={documents.activePath} tabsActive={tabsActive}
            completionData={{citationKeys: [], files: documents.fileList.map(file => file.relativePath), labels: []}}
            content={documents.content} cursorOffset={cursorOffset} diagnostics={[]} focusRequest={undefined}
            insertionRequest={undefined} openPaths={documents.openPaths} saveState={documents.saveState(documents.activePath ?? "")}
            onEditorSessionReady={documents.setEditorPort} onChange={documents.onChange}
            onClose={path => void documents.close(path)} onCompile={() => undefined} onOpenCommands={() => undefined}
            onCursorChange={setCursorOffset} onSelect={path => void documents.select(path)} preferences={preferences}
            citationDisabledReason="当前隔离预览尚未接入受管引用与文献库端口，暂不提供引用补全或插入。"
            onInsertCitation={() => undefined} syncActions={{forward: () => undefined, backward: () => undefined,
              forwardDisabled: undefined, backwardDisabled: undefined}}
            codeCheckEnabled={false} hasCodeCheckErrors={false} onCodeCheckResult={() => undefined} fileSessions={documents.files}/>
            : <p role="status">正在打开稿件文件与恢复检查点…</p>}
        </div>
      </div>
    </section>
    {active && conflict && <WritingFileConflictDialog manuscriptId={conflict.manuscriptId} relativePath={conflict.relativePath}
      bufferedContent={conflict.bufferedContent} diskContent={conflict.diskFile.content}
      onKeepEditing={documents.conflict.keepEditing} onReload={documents.conflict.reload} onSaveAs={documents.conflict.saveAs}/>}
  </>;
}
