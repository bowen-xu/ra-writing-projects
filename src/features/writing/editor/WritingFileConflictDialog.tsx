import { isWritingNotePath } from "@research-assistant/writing";
import { lazy, Suspense } from "react";
const WritingNoteEditor = lazy(() => import("../notes/WritingNoteEditor"));
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@research-assistant/workbench-sdk/overlay";

interface WritingFileConflictDialogProps {
  readonly manuscriptId?: string;
  readonly bufferedContent: string;
  readonly diskContent: string;
  readonly relativePath: string;
  readonly onKeepEditing: () => void;
  readonly onReload: () => void;
  readonly onSaveAs: (relativePath: string) => Promise<boolean>;
}

const MAX_COMPARISON_CHARACTERS = 100_000;

export function WritingFileConflictDialog(props: WritingFileConflictDialogProps): React.JSX.Element {
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [copyPath, setCopyPath] = useState(defaultCopyPath(props.relativePath));
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => () => previousFocusRef.current?.focus(), []);

  async function saveCopy(): Promise<void> {
    const path = copyPath.trim();
    if (path.length === 0 || isSaving) return;
    setIsSaving(true);
    if (!(await props.onSaveAs(path))) setIsSaving(false);
  }

  const isComparisonTruncated = props.bufferedContent.length > MAX_COMPARISON_CHARACTERS
    || props.diskContent.length > MAX_COMPARISON_CHARACTERS;

  return (
    <Dialog open portal backdrop={false} hideOnInteractOutside={false} hideOnEscape={!isSaving}
      onClose={props.onKeepEditing} finalFocus={previousFocusRef} style={{position: "fixed"}}
      className="writing-conflict-overlay" aria-label="解决稿件文件冲突">
      <section className="writing-conflict-dialog">
        <header>
          <div>
            <span>检测到磁盘修改</span>
            <h2>{props.relativePath} 未被覆盖</h2>
          </div>
        </header>
        <p>编辑缓冲仍保留在内存和恢复稿中。请选择磁盘版本，或把当前缓冲原子保存为新文件。</p>
        <div className="writing-conflict-comparison">
          <section>
            <h3>当前编辑缓冲</h3>
            {isWritingNotePath(props.relativePath) ? <Suspense fallback={<p>加载笔记…</p>}><WritingNoteEditor content={props.bufferedContent} manuscriptId={props.manuscriptId ?? ""} onChange={() => undefined} readOnly /></Suspense> : <pre>{comparisonPreview(props.bufferedContent)}</pre>}
          </section>
          <section>
            <h3>磁盘上的新版本</h3>
            {isWritingNotePath(props.relativePath) ? <Suspense fallback={<p>加载笔记…</p>}><WritingNoteEditor content={props.diskContent} manuscriptId={props.manuscriptId ?? ""} onChange={() => undefined} readOnly /></Suspense> : <pre>{comparisonPreview(props.diskContent)}</pre>}
          </section>
        </div>
        {isComparisonTruncated && <small>为保持界面响应，比较预览只显示前 100,000 个字符；另存时仍会保留完整缓冲。</small>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveCopy();
          }}
        >
          <label>另存为稿件相对路径<input disabled={isSaving} onChange={(event) => setCopyPath(event.target.value)} value={copyPath} /></label>
          <footer>
            <button disabled={isSaving} onClick={props.onKeepEditing} type="button">继续编辑</button>
            <button disabled={isSaving} onClick={props.onReload} type="button">重新载入磁盘版本</button>
            <button className="primary" disabled={copyPath.trim().length === 0 || isSaving} type="submit">
              {isSaving ? "正在另存…" : "保留缓冲并另存"}
            </button>
          </footer>
        </form>
      </section>
    </Dialog>
  );
}

export function defaultCopyPath(relativePath: string): string {
  const slashIndex = relativePath.lastIndexOf("/");
  const directory = slashIndex < 0 ? "" : relativePath.slice(0, slashIndex + 1);
  const filename = slashIndex < 0 ? relativePath : relativePath.slice(slashIndex + 1);
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return `${directory}${filename}-conflict-copy`;
  return `${directory}${filename.slice(0, dotIndex)}-conflict-copy${filename.slice(dotIndex)}`;
}

function comparisonPreview(content: string): string {
  return content.length <= MAX_COMPARISON_CHARACTERS
    ? content
    : `${content.slice(0, MAX_COMPARISON_CHARACTERS)}\n…`;
}
