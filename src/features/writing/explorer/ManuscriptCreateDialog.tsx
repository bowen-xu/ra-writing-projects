import { useState, type FormEvent } from "react";
import { Dialog } from "@research-assistant/workbench-sdk/overlay";

interface ManuscriptCreateDialogProps {
  readonly canCancel: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (title: string) => Promise<void>;
}

export function ManuscriptCreateDialog(props: ManuscriptCreateDialogProps): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (title.trim().length === 0) return;
    setIsSubmitting(true);
    try {
      await props.onCreate(title.trim());
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open portal backdrop={false} hideOnInteractOutside={false} hideOnEscape={props.canCancel && !isSubmitting}
      onClose={props.onCancel} style={{position: "fixed"}} className="writing-create-overlay" aria-label="新建 LaTeX 稿件">
      <form onSubmit={(event) => void submit(event)}>
        <span className="eyebrow">NEW MANUSCRIPT</span>
        <h2>创建 LaTeX 论文</h2>
        <p>源码将保存在应用受管的普通工程目录，默认根文档为 main.tex。</p>
        <label>论文标题<input autoFocus maxLength={180} onChange={(event) => setTitle(event.target.value)} placeholder="例如：多模态证据检索研究" value={title} /></label>
        <div>
          {props.canCancel && <button className="ghost-button" onClick={props.onCancel} type="button">取消</button>}
          <button className="primary-button" disabled={title.trim().length === 0 || isSubmitting} type="submit">{isSubmitting ? "正在创建…" : "创建稿件"}</button>
        </div>
      </form>
    </Dialog>
  );
}
