import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { ChevronDown, Settings2, Minimize } from "lucide-react";
import type { Manuscript } from "@research-assistant/writing";
import { useRef, type ReactNode } from "react";
import type { SaveState } from "./workspaceState";
import { WritingMenu, WritingMenuItem } from "./WritingMenu";
import { WritingProjectMenu } from "./WritingProjectMenu";
import { WritingLayoutMenu } from "./WritingLayoutMenu";
import type { WritingViewMode } from "./useWritingLayout";
import type { ManuscriptGitBranches, ManuscriptVersionCommit, ManuscriptVersionDiff } from "../../public/contracts/gitVersionGateway";
import type { HistoricalVersionFile } from "../../public/contracts/gitVersionGateway";
import type { ManuscriptGitWorktree } from "../../public/contracts/gitWorktreeGateway";

interface WritingToolbarProps {
  readonly activeManuscript: Manuscript | undefined;
  readonly saveState: SaveState;
  readonly recoveryActions?: ReactNode;
  readonly onSave: () => void;
  readonly onOpenCommands: (returnFocus?: HTMLElement) => void;
  readonly onSettings: () => void;
  readonly onBibliography?: () => void;
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
  readonly projectActions: ReactNode;
  readonly viewMode: WritingViewMode;
  readonly onViewModeChange: (mode: WritingViewMode) => void;
  readonly focused: boolean;
  readonly onToggleFocus: () => void;
  readonly transferActions: ReactNode;
}

export function WritingToolbar(props: WritingToolbarProps): React.JSX.Element {
  const fileTrigger = useRef<HTMLButtonElement>(null);
  return (
    <header className="writing-toolbar" data-focused={props.focused}>
      {!props.focused && <WritingMenu triggerRef={fileTrigger} label="文件" trigger={<>文件<ChevronDown size={13} /></>} className="writing-menu" contentClassName="writing-menu-content">
          <WritingMenuItem onClick={props.onSave} disabled={props.saveState === "saving"} type="button">保存当前文件</WritingMenuItem>
          {props.transferActions}
          <WritingMenuItem onClick={props.onBibliography} disabled={!props.activeManuscript} type="button">参考文献管理</WritingMenuItem>
          <WritingMenuItem onClick={() => props.onOpenCommands(fileTrigger.current ?? undefined)} type="button">命令面板</WritingMenuItem>
      </WritingMenu>}
      <WritingProjectMenu manuscript={props.activeManuscript} exports={props.projectActions} onRename={props.onRename} onCreateVersion={props.onCreateVersion} onInitializeGit={props.onInitializeGit} onListVersions={props.onListVersions} onDiffVersions={props.onDiffVersions} onListBranches={props.onListBranches} onCreateBranch={props.onCreateBranch} onDeleteBranch={props.onDeleteBranch} activeFilePath={props.activeFilePath} onReadVersionFile={props.onReadVersionFile} onRestoreVersion={props.onRestoreVersion} onListWorktrees={props.onListWorktrees} onCreateWorktree={props.onCreateWorktree} onRemoveWorktree={props.onRemoveWorktree} />
      {props.recoveryActions}
      <span className={"save-state " + props.saveState} role="status">{saveLabel(props.saveState)}</span>
      <WritingLayoutMenu mode={props.viewMode} onMode={props.onViewModeChange} focused={props.focused} onFocus={props.onToggleFocus} />
      {props.focused ? <button className="writing-exit-focus" onClick={props.onToggleFocus} type="button"><Minimize size={17} />退出专注</button> : <ControlHint content="写作设置"><button className="writing-icon-button" aria-label="写作设置" onClick={props.onSettings} type="button"><Settings2 size={18} /></button></ControlHint>}
    </header>
  );
}

function saveLabel(state: SaveState): string {
  if (state === "dirty") return "等待保存";
  if (state === "saving") return "正在保存";
  if (state === "error") return "保存失败";
  return "已保存";
}
