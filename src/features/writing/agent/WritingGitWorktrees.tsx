import { useEffect, useRef, useState } from "react";
import type { ManuscriptGitWorktree } from "../../../public/contracts/gitWorktreeGateway";

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly worktrees: readonly ManuscriptGitWorktree[];
  readonly loading: boolean;
  readonly onCreate: (revision: string) => Promise<void>;
  readonly onRemove: (id: string, discardChanges: boolean) => Promise<void>;
}

export function WritingGitWorktrees(props: Props): React.JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null);
  const [revision, setRevision] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open && !dialog.current?.open) dialog.current?.showModal();
    if (!props.open && dialog.current?.open) dialog.current?.close();
  }, [props.open]);
  if (!props.open) return null;
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); try { await action(); } finally { setBusy(false); } };
  return <dialog className="writing-rename-dialog" ref={dialog} aria-label="Git 隔离工作区" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); props.onClose(); }}>
      <h2>Git 隔离工作区</h2>
      {props.loading ? <p>正在读取工作区…</p> : props.worktrees.length === 0 ? <p>暂无应用创建的隔离工作区。</p> : <ul>
        {props.worktrees.map((item) => <li key={item.id}>
          <strong>{item.revision}</strong> · {item.state === "recovery_required" ? "需要恢复" : item.state === "released" ? "已释放" : "活动"}
          {item.status && <span> · {item.status.dirty ? `有变更（暂存 ${item.status.stagedCount}，未暂存 ${item.status.unstagedCount}，未跟踪 ${item.status.untrackedCount}）` : "干净"}</span>}
          <br /><small>{item.worktreePath}</small>
          {item.state !== "released" && <span className="writing-worktree-actions"><button type="button" disabled={busy} onClick={() => void run(() => props.onRemove(item.id, false))}>释放</button><button type="button" disabled={busy} onClick={() => void run(() => props.onRemove(item.id, true))}>丢弃并释放</button></span>}
        </li>)}
      </ul>}
      <label>基于版本<input value={revision} maxLength={128} disabled={busy} onChange={(event) => setRevision(event.target.value)} /></label>
      <div className="writing-rename-actions"><button type="button" disabled={busy} onClick={() => void run(() => props.onCreate(revision.trim() || "HEAD"))}>创建工作区</button><button className="writing-primary" type="submit" disabled={busy}>关闭</button></div>
    </form>
  </dialog>;
}
