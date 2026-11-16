import type { ManuscriptVersionGateway, ManuscriptVersionCommit } from "../../../../../src/public/gitVersionGateway.ts";
import type { GitWorktreeGateway, ManuscriptGitWorktree } from "../../../../../src/public/gitWorktreeGateway.ts";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";

interface Version { readonly commit: ManuscriptVersionCommit; readonly files: readonly { path: string; content: string; kind: "text" | "binary"; byteSize: number }[]; }
export function createMockGitGateways(storage: Storage, writing: WritingGateway) {
  const versions = new Map<string, Version[]>(JSON.parse(storage.getItem("git-versions") ?? "[]") as [string, Version[]][]);
  const branches = new Map<string, string[]>(JSON.parse(storage.getItem("git-branches") ?? "[]") as [string, string[]][]);
  const trees = new Map<string, ManuscriptGitWorktree>(JSON.parse(storage.getItem("git-worktrees") ?? "[]") as [string, ManuscriptGitWorktree][]);
  const branchView = (id: string) => ({ schemaVersion: 1, manuscriptId: id, current: "main", branches: branches.get(id) ?? ["main"] });
  const persist = () => { storage.setItem("git-versions", JSON.stringify([...versions])); storage.setItem("git-branches", JSON.stringify([...branches])); storage.setItem("git-worktrees", JSON.stringify([...trees])); };
  const files = (id: string, revision: string) => { const value = versions.get(id)?.find(value => value.commit.sha === revision); if (!value) throw new Error("模拟版本不存在"); return value.files; };
  const git: ManuscriptVersionGateway = {
    initialize: async manuscriptId => ({ schemaVersion: 1, manuscriptId, root: `mock://manuscripts/${manuscriptId}`, branch: "main" }),
    listBranches: async id => branchView(id),
    createBranch: async (id, branch) => { branches.set(id, [...new Set([...branchView(id).branches, branch])]); persist(); return branchView(id); },
    deleteBranch: async (id, branch) => { if (branch === "main") throw new Error("不能删除当前分支"); branches.set(id, branchView(id).branches.filter(value => value !== branch)); persist(); return branchView(id); },
    list: async (manuscriptId, limit = 100) => ({ schemaVersion: 1, manuscriptId, commits: (versions.get(manuscriptId) ?? []).map(value => value.commit).slice(-limit).reverse() }),
    create: async (id, message) => {
      const contents = await Promise.all((await writing.listFiles(id)).map(async file => ({ path: file.relativePath, content: (await writing.readFile(id, file.relativePath)).content, kind: file.kind === "image" ? "binary" as const : "text" as const, byteSize: file.sizeBytes })));
      const commit: ManuscriptVersionCommit = { sha: (await writingDiffDemoHash(JSON.stringify(contents) + message + Date.now())).slice(0, 40), timestampUnixSeconds: Math.floor(Date.now() / 1000), subject: message };
      versions.set(id, [...(versions.get(id) ?? []), { commit, files: contents }]); persist(); return commit;
    },
    readFile: async (manuscriptId, revision, relativePath) => { const value = files(manuscriptId, revision).find(file => file.path === relativePath); if (!value) throw new Error("该版本没有此文件"); return { schemaVersion: 1, manuscriptId, revision, relativePath, kind: value.kind, content: value.content, byteSize: value.byteSize }; },
    diffVersions: async (manuscriptId, fromRevision, toRevision) => { const before = files(manuscriptId, fromRevision), after = files(manuscriptId, toRevision); const content = after.filter(file => file.content !== before.find(value => value.path === file.path)?.content).map(file => `+++ ${file.path}\n${file.content}`).join("\n"); return { schemaVersion: 1, manuscriptId, fromRevision, toRevision, kind: "text", content, byteSize: new TextEncoder().encode(content).length }; },
    latestRestoreScope: async () => null,
    restoreVersion: async () => { throw new Error("预览未覆盖 Git 版本恢复提案；未更改文件"); },
  };
  const worktrees: GitWorktreeGateway = {
    list: async id => [...trees.values()].filter(value => value.manuscriptId === id),
    create: async (manuscriptId, revision = "main") => { const id = crypto.randomUUID(), value: ManuscriptGitWorktree = { schemaVersion: 1, id, manuscriptId, revision, repositoryRoot: `mock://manuscripts/${manuscriptId}`, worktreePath: `mock://worktrees/${id}`, state: "active" }; trees.set(id, value); persist(); return value; },
    remove: async (_manuscriptId, id) => { trees.delete(id); persist(); },
  };
  return { getManuscriptVersionGateway: git, getGitWorktreeGateway: worktrees };
}
