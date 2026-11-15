import { useEffect, useRef, useState } from "react";
import type { ManuscriptGitBranches } from "../../../public/contracts/gitVersionGateway";

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly value: ManuscriptGitBranches | undefined;
  readonly loading: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onCreate: (branch: string) => Promise<void>;
  readonly onDelete: (branch: string) => Promise<void>;
}

export function WritingGitBranches(props: Props): React.JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open && !dialog.current?.open) dialog.current?.showModal();
    if (!props.open && dialog.current?.open) dialog.current?.close();
  }, [props.open]);
  if (!props.open) return null;
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); try { await action(); } finally { setBusy(false); } };
  return <dialog className="writing-rename-dialog" ref={dialog} aria-label="Git 分支" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); props.onClose(); }}>
      <h2>Git 分支</h2>
      {props.loading ? <p>正在读取分支…</p> : props.value?.branches.length ? <ul>
        {props.value.branches.map((item) => <li key={item}><strong>{item}</strong>{item === props.value?.current && " · 当前分支"}
          {item !== props.value?.current && <button type="button" disabled={busy} onClick={() => void run(() => props.onDelete(item))}>删除</button>}</li>)}
      </ul> : <p>暂无本地分支。</p>}
      <label>新分支名称<input value={branch} maxLength={255} disabled={busy} onChange={(event) => setBranch(event.target.value)} /></label>
      <div className="writing-rename-actions"><button type="button" disabled={busy || !branch.trim()} onClick={() => void run(async () => { await props.onCreate(branch.trim()); setBranch(""); })}>创建分支</button><button type="button" disabled={busy} onClick={() => void run(props.onRefresh)}>刷新</button><button className="writing-primary" type="submit" disabled={busy}>关闭</button></div>
    </form>
  </dialog>;
}
