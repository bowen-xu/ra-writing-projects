import type { ComponentProps } from "react";
import type { WritingToolbar } from "./WritingToolbar";
import type { getManuscriptVersionGateway } from "@research-assistant/workbench-sdk/git-versions";
import type { getGitWorktreeGateway } from "@research-assistant/workbench-sdk/git-worktrees";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { errorMessage } from "./workspaceState";

type VersionActions = Pick<ComponentProps<typeof WritingToolbar>, "onCreateVersion" | "onListVersions" | "onDiffVersions" | "onListBranches" | "onCreateBranch" | "onDeleteBranch" | "onInitializeGit" | "onListWorktrees" | "onCreateWorktree" | "onRemoveWorktree">;
/** Project menu ownership, independent of document-window composition. */
export function writingProjectVersionActions(activeManuscriptId: string | undefined,
  gitVersionGateway: ReturnType<typeof getManuscriptVersionGateway>, gitWorktreeGateway: ReturnType<typeof getGitWorktreeGateway>): VersionActions {
  if (!activeManuscriptId) return {};
  return {
    onCreateVersion: async () => {
          try {
            const commit = await gitVersionGateway.create(activeManuscriptId, "更新稿件版本");
            notify.success(`已创建版本 ${commit.sha.slice(0, 8)}`);
            return commit;
          } catch (reason) {
            notify.error(errorMessage(reason));
            return undefined;
          }
        },
    onListVersions: async () => {
          try { return (await gitVersionGateway.list(activeManuscriptId)).commits; }
          catch (reason) { notify.error(errorMessage(reason)); return []; }
        },
    onDiffVersions: async (fromRevision, toRevision) => {
          try { return await gitVersionGateway.diffVersions(activeManuscriptId, fromRevision, toRevision); }
          catch (reason) { notify.error(errorMessage(reason)); throw reason; }
        },
    onListBranches: async () => {
          try { return await gitVersionGateway.listBranches(activeManuscriptId); }
          catch (reason) { notify.error(errorMessage(reason)); throw reason; }
        },
    onCreateBranch: async (branch) => {
          try { await gitVersionGateway.createBranch(activeManuscriptId, branch); notify.success(`已创建分支 ${branch}`); }
          catch (reason) { notify.error(errorMessage(reason)); }
        },
    onDeleteBranch: async (branch) => {
          try { await gitVersionGateway.deleteBranch(activeManuscriptId, branch); notify.success(`已删除分支 ${branch}`); }
          catch (reason) { notify.error(errorMessage(reason)); }
        },
    onInitializeGit: async () => {
          try { await gitVersionGateway.initialize(activeManuscriptId); notify.success("已初始化 Git 版本管理"); }
          catch (reason) { notify.error(errorMessage(reason)); }
        },
    onListWorktrees: async () => {
          try { return await gitWorktreeGateway.list(activeManuscriptId); }
          catch (reason) { notify.error(errorMessage(reason)); return []; }
        },
    onCreateWorktree: async (revision) => {
          try { await gitWorktreeGateway.create(activeManuscriptId, revision); notify.success("已创建 Git 隔离工作区"); }
          catch (reason) { notify.error(errorMessage(reason)); }
        },
    onRemoveWorktree: async (id, discardChanges) => {
          try { await gitWorktreeGateway.remove(activeManuscriptId, id, discardChanges); notify.success(discardChanges ? "已丢弃并释放工作区" : "已释放工作区"); }
          catch (reason) { notify.error(errorMessage(reason)); }
        }
  };
}
