import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { WritingMenu, WritingMenuItem } from "./WritingMenu";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@research-assistant/workbench-sdk/overlay";
import type { Manuscript } from "@research-assistant/writing";
import type { HistoricalVersionFile, ManuscriptGitBranches, ManuscriptVersionCommit, ManuscriptVersionDiff } from "../../public/contracts/gitVersionGateway";
import type { ManuscriptGitWorktree } from "../../public/contracts/gitWorktreeGateway";
import { WritingGitWorktrees } from "./agent/WritingGitWorktrees";
import { WritingGitBranches } from "./agent/WritingGitBranches";

interface Props {
  readonly manuscript: Manuscript | undefined;
  readonly exports: ReactNode;
  readonly onRename: (title: string) => Promise<boolean>;
  readonly onCreateVersion?: (() => Promise<ManuscriptVersionCommit | undefined>) | undefined;
  readonly onInitializeGit?: (() => Promise<void>) | undefined;
  readonly onListVersions?: (() => Promise<readonly ManuscriptVersionCommit[]>) | undefined;
  readonly onDiffVersions?: ((fromRevision: string, toRevision: string) => Promise<ManuscriptVersionDiff>) | undefined;
  readonly onListBranches?: (() => Promise<ManuscriptGitBranches>) | undefined;
  readonly onCreateBranch?: ((branch: string) => Promise<void>) | undefined;
  readonly onDeleteBranch?: ((branch: string) => Promise<void>) | undefined;
  readonly activeFilePath?: string | undefined;
  readonly onReadVersionFile?: ((revision: string, relativePath: string) => Promise<HistoricalVersionFile>) | undefined;
  readonly onRestoreVersion?: ((revision: string) => Promise<void>) | undefined;
  readonly onListWorktrees?: (() => Promise<readonly ManuscriptGitWorktree[]>) | undefined;
  readonly onCreateWorktree?: ((revision: string) => Promise<void>) | undefined;
  readonly onRemoveWorktree?: ((id: string, discardChanges: boolean) => Promise<void>) | undefined;
}

export function WritingProjectMenu({ manuscript, exports, onRename, onCreateVersion, onInitializeGit, onListVersions, onDiffVersions, onListBranches, onCreateBranch, onDeleteBranch, activeFilePath, onReadVersionFile, onRestoreVersion, onListWorktrees, onCreateWorktree, onRemoveWorktree }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [versions, setVersions] = useState<readonly ManuscriptVersionCommit[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionPreview, setVersionPreview] = useState<HistoricalVersionFile | undefined>();
  const [versionPreviewLoading, setVersionPreviewLoading] = useState(false);
  const [versionDiff, setVersionDiff] = useState<ManuscriptVersionDiff>();
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<readonly ManuscriptGitWorktree[]>([]);
  const [worktreesLoading, setWorktreesLoading] = useState(false);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [branches, setBranches] = useState<ManuscriptGitBranches>();
  const [branchesLoading, setBranchesLoading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (renaming) { dialog.current?.showModal(); dialog.current?.querySelector("input")?.select(); } }, [renaming]);
  useEffect(() => { setOpen(false); setRenaming(false); setVersionDialogOpen(false); setVersions([]); setWorktreeDialogOpen(false); setWorktrees([]); }, [manuscript?.id]);
  function cancelRename(): void { if (!saving) { setRenaming(false); trigger.current?.focus(); } }
  async function showVersions(): Promise<void> {
    if (!onListVersions) return;
    setVersionsLoading(true);
    try { setVersions(await onListVersions()); setVersionPreview(undefined); setVersionDiff(undefined); setVersionDialogOpen(true); }
    catch { /* the host reports the actionable error */ }
    finally { setVersionsLoading(false); }
  }
  async function showWorktrees(): Promise<void> {
    if (!onListWorktrees) return;
    setWorktreesLoading(true);
    try { setWorktrees(await onListWorktrees()); setWorktreeDialogOpen(true); }
    catch { /* host reports the actionable error */ }
    finally { setWorktreesLoading(false); }
  }
  async function showBranches(): Promise<void> {
    if (!onListBranches) return;
    setBranchesLoading(true);
    try { setBranches(await onListBranches()); setBranchDialogOpen(true); }
    catch { /* the host reports the actionable error */ }
    finally { setBranchesLoading(false); }
  }
  return <div className="writing-project-title">
    <WritingMenu label={`稿件菜单：${manuscript?.title ?? "论文写作"}`} menuLabel="稿件操作" className="writing-project-menu" triggerClassName="writing-project-trigger" contentClassName="writing-project-options" triggerRef={trigger} disabled={!manuscript} open={open} setOpen={setOpen} autoFocusOnHide={!renaming} trigger={<><ControlHint content={manuscript?.title}><strong>{manuscript?.title ?? "论文写作"}</strong></ControlHint><ChevronDown size={15} /></>}>
      {exports}<hr />
      {onListVersions && <WritingMenuItem disabled={versionsLoading} onClick={() => void showVersions()}>{versionsLoading ? "正在读取版本…" : "查看 Git 版本"}</WritingMenuItem>}
      {onCreateVersion && <WritingMenuItem onClick={() => void onCreateVersion()} disabled={!manuscript}>创建 Git 版本</WritingMenuItem>}
      {onListWorktrees && <WritingMenuItem disabled={worktreesLoading} onClick={() => void showWorktrees()}>{worktreesLoading ? "正在读取工作区…" : "Git 隔离工作区"}</WritingMenuItem>}
      {onListBranches && <WritingMenuItem disabled={branchesLoading} onClick={() => void showBranches()}>{branchesLoading ? "正在读取分支…" : "Git 分支"}</WritingMenuItem>}
      {onInitializeGit && <WritingMenuItem onClick={() => void onInitializeGit()} disabled={!manuscript}>初始化 Git 版本管理</WritingMenuItem>}
      {(onListVersions || onCreateVersion || onInitializeGit) && <hr />}
      <WritingMenuItem onClick={() => { setTitle(manuscript?.title ?? ""); setRenaming(true); }}>重命名稿件</WritingMenuItem>
    </WritingMenu>
    {manuscript?.status === "archived" && <span className="writing-archived-badge">已归档</span>}
    {versionDialogOpen && <Dialog modal={false} portal open onClose={() => setVersionDialogOpen(false)} className="writing-rename-dialog" aria-label="Git 版本历史" onClick={(event) => { if (event.target === event.currentTarget) setVersionDialogOpen(false); }}>
      <form onSubmit={event => { event.preventDefault(); setVersionDialogOpen(false); }}>
        <h2>Git 版本</h2>
        {versions.length === 0 ? <p>暂无提交版本。</p> : <ul>{versions.map((version, index) => { const previous = versions[index + 1]; return <li key={version.sha}><strong>{version.subject}</strong><br /><small>{version.sha.slice(0, 12)}</small>{onReadVersionFile && activeFilePath && <button type="button" disabled={versionPreviewLoading} onClick={() => { setVersionPreviewLoading(true); void onReadVersionFile(version.sha, activeFilePath).then(setVersionPreview).catch(() => setVersionPreview(undefined)).finally(() => setVersionPreviewLoading(false)); }}>{versionPreviewLoading ? "读取中…" : "预览当前文件"}</button>}{onDiffVersions && previous && <button type="button" disabled={versionPreviewLoading} onClick={() => { setVersionPreviewLoading(true); void onDiffVersions(previous.sha, version.sha).then(setVersionDiff).catch(() => setVersionDiff(undefined)).finally(() => setVersionPreviewLoading(false)); }}>比较上一版本</button>}{onRestoreVersion && <button type="button" disabled={versionPreviewLoading} onClick={() => { setVersionPreviewLoading(true); void onRestoreVersion(version.sha).catch(() => undefined).finally(() => setVersionPreviewLoading(false)); }}>恢复为待审变更</button>}</li>; })}</ul>}
        {versionPreview && <pre className="writing-version-preview" aria-label="历史版本文件预览">{versionPreview.kind === "text" ? versionPreview.content : `二进制文件（${versionPreview.byteSize} bytes）`}</pre>}
        {versionDiff && <pre className="writing-version-preview" aria-label="Git 版本差异预览">{versionDiff.kind === "text" ? versionDiff.content : `二进制差异（${versionDiff.byteSize} bytes）`}</pre>}
        <div className="writing-rename-actions"><button className="writing-primary" type="submit">关闭</button></div>
      </form>
    </Dialog>}
    <WritingGitWorktrees open={worktreeDialogOpen} onClose={() => setWorktreeDialogOpen(false)} worktrees={worktrees} loading={worktreesLoading}
      onCreate={async (revision) => { if (onCreateWorktree) { await onCreateWorktree(revision); setWorktrees(onListWorktrees ? await onListWorktrees() : worktrees); } }}
      onRemove={async (id, discard) => { if (onRemoveWorktree) { await onRemoveWorktree(id, discard); setWorktrees(onListWorktrees ? await onListWorktrees() : worktrees); } }} />
    <WritingGitBranches open={branchDialogOpen} onClose={() => setBranchDialogOpen(false)} value={branches} loading={branchesLoading}
      onRefresh={showBranches}
      onCreate={async (branch) => { if (onCreateBranch) { await onCreateBranch(branch); setBranches(await onListBranches?.() ?? branches); } }}
      onDelete={async (branch) => { if (onDeleteBranch) { await onDeleteBranch(branch); setBranches(await onListBranches?.() ?? branches); } }} />
    {renaming && createPortal(<dialog className="writing-rename-dialog" ref={dialog} aria-label="重命名稿件" onCancel={(event) => { event.preventDefault(); cancelRename(); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (saving || !title.trim()) return; setSaving(true); void onRename(title.trim()).then((success) => { if (success) { setRenaming(false); trigger.current?.focus(); } }).finally(() => setSaving(false)); }}>
        <h2>重命名稿件</h2>
        <label>稿件名称<input autoFocus value={title} maxLength={180} disabled={saving} onChange={(event) => setTitle(event.target.value)} /></label>
        <div className="writing-rename-actions"><button type="button" disabled={saving} onClick={cancelRename}>取消</button><button className="writing-primary" type="submit" disabled={saving || !title.trim()}>{saving ? "正在保存…" : "保存"}</button></div>
      </form>
    </dialog>, document.body)}
  </div>;
}
