import type { ManuscriptImportPreview } from "@research-assistant/writing";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@research-assistant/workbench-sdk/overlay";

interface ManuscriptImportDialogProps {
  readonly initialTitle: string;
  readonly preview: ManuscriptImportPreview;
  readonly sourceLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: (title: string, rootPath: string) => Promise<boolean>;
}

export function ManuscriptImportDialog(props: ManuscriptImportDialogProps): React.JSX.Element {
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [title, setTitle] = useState(props.initialTitle);
  const [rootPath, setRootPath] = useState(props.preview.rootCandidates[0] ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canImport = title.trim().length > 0 && rootPath.length > 0 && !isSubmitting;

  useEffect(() => () => previousFocusRef.current?.focus(), []);

  async function confirm(): Promise<void> {
    if (!canImport) return;
    setIsSubmitting(true);
    if (await props.onConfirm(title.trim(), rootPath)) {
      props.onCancel();
      return;
    }
    setIsSubmitting(false);
  }

  return (
    <Dialog open portal backdrop={false} hideOnInteractOutside={false} hideOnEscape={!isSubmitting}
      onClose={props.onCancel} finalFocus={previousFocusRef} style={{position: "fixed"}} aria-label="确认导入 LaTeX 工程"
      className="writing-import-overlay"
      onMouseDown={(event) => {
        if (!isSubmitting && event.target === event.currentTarget) props.onCancel();
      }}
    >
      <section
        className="writing-import-dialog"
      >
        <header>
          <div>
            <span>安全导入预检</span>
            <h2>确认 LaTeX 工程</h2>
          </div>
          <button aria-label="取消导入" onClick={props.onCancel} type="button">×</button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <div className="writing-import-summary">
            <strong>{props.sourceLabel}</strong>
            <span>{props.preview.fileCount} 个文件 · {formatBytes(props.preview.byteSize)}</span>
          </div>
          <label>
            稿件标题
            <input
              autoFocus
              maxLength={180}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <label>
            根文档
            <select
              disabled={props.preview.rootCandidates.length === 0}
              onChange={(event) => setRootPath(event.target.value)}
              value={rootPath}
            >
              {props.preview.rootCandidates.map((candidate) => (
                <option key={candidate} value={candidate}>{candidate}</option>
              ))}
            </select>
          </label>
          {props.preview.rootCandidates.length === 0 && (
            <div className="writing-import-warning" role="alert">
              未发现包含 <code>\documentclass</code> 的根文档，不能作为 LaTeX 工程导入。
            </div>
          )}
          {props.preview.rootCandidates.length > 1 && (
            <div className="writing-import-note">
              检测到多个可编译入口。请选择打开工作区后默认编译的根文档。
            </div>
          )}
          <footer>
            <button disabled={isSubmitting} onClick={props.onCancel} type="button">取消</button>
            <button className="primary" disabled={!canImport} type="submit">
              {isSubmitting ? "正在复制…" : "复制到受管工程"}
            </button>
          </footer>
        </form>
      </section>
    </Dialog>
  );
}

function formatBytes(value: number): string {
  return value < 1024 * 1024
    ? `${Math.ceil(value / 1024)} KiB`
    : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
