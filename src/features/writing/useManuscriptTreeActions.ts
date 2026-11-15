import type { WritingFileSessions } from "./editor/writingFileSessions";
import { clearWritingRecoveryDraft } from "./persistence/clearWritingRecoveryDraft";
import { createWritingNote, writingNoteTitle, isWritingNotePath, isWritingSourcePath, parseManuscriptPath, type Manuscript, type ManuscriptDirectory, type ManuscriptFile } from "@research-assistant/writing";
import type { Dispatch, SetStateAction } from "react";

import type { WritingGateway } from "./gateway";
import { errorMessage, type SaveState } from "./workspaceState";

interface ManuscriptTreeActionOptions {
  readonly fileSessions?: WritingFileSessions;
  readonly activeManuscript: Manuscript | undefined;
  readonly activeManuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly files: readonly ManuscriptFile[];
  readonly gateway: WritingGateway;
  readonly openFile: (path: string) => Promise<unknown>;
  readonly onSourceChanged: () => void;
  readonly saveCurrent: () => Promise<boolean>;
  readonly saveState: SaveState;
  readonly setDirectories: Dispatch<SetStateAction<readonly ManuscriptDirectory[]>>;
  readonly setError: Dispatch<SetStateAction<string | undefined>>;
  readonly setFiles: Dispatch<SetStateAction<readonly ManuscriptFile[]>>;
  readonly setManuscripts: Dispatch<SetStateAction<readonly Manuscript[]>>;
  readonly setOpenPaths: Dispatch<SetStateAction<readonly string[]>>;
}

interface ManuscriptTreeActions {
  readonly createDirectory: (path: string) => Promise<void>;
  readonly createFile: (path: string) => Promise<void>;
  readonly deleteDirectory: (path: string) => Promise<void>;
  readonly deleteFile: (path: string) => Promise<void>;
  readonly refreshTree: () => Promise<void>;
  readonly renameDirectory: (fromPath: string, toPath: string) => Promise<void>;
  readonly renameFile: (fromPath: string, toPath: string) => Promise<void>;
}

export function useManuscriptTreeActions(options: ManuscriptTreeActionOptions): ManuscriptTreeActions {
  async function refreshTree(): Promise<void> {
    if (options.activeManuscriptId === undefined) return;
    const [files, directories] = await Promise.all([
      options.gateway.listFiles(options.activeManuscriptId),
      options.gateway.listDirectories(options.activeManuscriptId),
    ]);
    options.setFiles(files);
    options.setDirectories(directories);
  }

  async function createFile(path: string): Promise<void> {
    if (options.activeManuscriptId === undefined) return;
    if (!(await options.saveCurrent())) return;
    try {
      const content = isWritingNotePath(path) ? JSON.stringify(createWritingNote(crypto.randomUUID(), crypto.randomUUID(), writingNoteTitle(path))) : "";
      const file = await options.gateway.createFile(options.activeManuscriptId, parseManuscriptPath(path), content);
      await refreshTree();
      if (isWritingSourcePath(path)) options.onSourceChanged();
      await options.openFile(file.relativePath);
    } catch (reason: unknown) { options.setError(errorMessage(reason)); }
  }

  async function renameFile(fromPath: string, toPath: string): Promise<void> {
    if (options.activeManuscriptId === undefined) return;
    if (!(await options.saveCurrent())) return;
    try {
      const updated = await options.gateway.renameFile(options.activeManuscriptId, fromPath, parseManuscriptPath(toPath));
      updateManuscript(options.setManuscripts, updated);
      options.setOpenPaths((current) => current.map((path) => path === fromPath ? toPath : path));
      await refreshTree();
      if (isWritingSourcePath(fromPath) || isWritingSourcePath(toPath)) options.onSourceChanged();
      if (fromPath === options.activePath) await options.openFile(toPath);
    } catch (reason: unknown) { options.setError(errorMessage(reason)); }
  }

  async function deleteFile(path: string): Promise<void> {
    if (options.activeManuscriptId === undefined) return;
    const losesUnsaved = path === options.activePath && isUnsaved(options.saveState);
    const warning = losesUnsaved ? "该文件还有未保存修改，也会一并丢失。" : "";
    if (!window.confirm(`删除 ${path}？${warning}此操作会立即移除受管工程中的文件。`)) return;
    if (!(await options.saveCurrent())) return;
    try {
      await options.gateway.deleteFile(options.activeManuscriptId, path);
      options.setOpenPaths((current) => current.filter((value) => value !== path));
      await refreshTree();
      await clearWritingRecoveryDraft(options.fileSessions, { manuscriptId: options.activeManuscriptId, relativePath: path }, "delete-file", () => options.gateway.clearRecoveryDraft(options.activeManuscriptId!, path));
      if (isWritingSourcePath(path)) options.onSourceChanged();
      if (path === options.activePath) {
        const files = await options.gateway.listFiles(options.activeManuscriptId);
        await options.openFile(options.activeManuscript?.rootPath ?? files[0]?.relativePath ?? "");
      }
    } catch (reason: unknown) { options.setError(errorMessage(reason)); }
  }

  function directoryAffectsSource(path: string): boolean {
    return (path !== "notes" && !path.startsWith("notes/")) || options.files.some(file => pathIsWithin(file.relativePath, path) && isWritingSourcePath(file.relativePath));
  }

  async function createDirectory(path: string): Promise<void> {
    if (options.activeManuscriptId === undefined) return;
    try {
      await options.gateway.createDirectory(options.activeManuscriptId, parseManuscriptPath(path));
      await refreshTree();
      if (directoryAffectsSource(path)) options.onSourceChanged();
    } catch (reason: unknown) { options.setError(errorMessage(reason)); }
  }

  async function renameDirectory(fromPath: string, toPath: string): Promise<void> {
    if (options.activeManuscriptId === undefined) return;
    const activeIsWithin = options.activePath !== undefined && pathIsWithin(options.activePath, fromPath);
    if (activeIsWithin && isUnsaved(options.saveState) && !(await options.saveCurrent())) return;
    try {
      const updated = await options.gateway.renameDirectory(options.activeManuscriptId, fromPath, parseManuscriptPath(toPath));
      updateManuscript(options.setManuscripts, updated);
      options.setOpenPaths((current) => current.map((path) => relocatePath(path, fromPath, toPath)));
      await refreshTree();
      if (directoryAffectsSource(fromPath) || directoryAffectsSource(toPath)) options.onSourceChanged();
      if (activeIsWithin && options.activePath !== undefined) {
        await options.openFile(relocatePath(options.activePath, fromPath, toPath));
      }
    } catch (reason: unknown) { options.setError(errorMessage(reason)); }
  }

  async function deleteDirectory(path: string): Promise<void> {
    if (options.activeManuscriptId === undefined) return;
    const count = options.files.filter((file) => pathIsWithin(file.relativePath, path)).length;
    const activeIsWithin = options.activePath !== undefined && pathIsWithin(options.activePath, path);
    const warning = activeIsWithin && isUnsaved(options.saveState) ? "当前文件还有未保存修改，也会一并丢失。" : "";
    if (!window.confirm(`删除目录 ${path}/ 及其中 ${count} 个文件？${warning}此操作会立即移除受管工程内容。`)) return;
    try {
      await options.gateway.deleteDirectory(options.activeManuscriptId, path);
      options.setOpenPaths((current) => current.filter((value) => !pathIsWithin(value, path)));
      await refreshTree();
      if (directoryAffectsSource(path)) options.onSourceChanged();
      if (activeIsWithin) {
        const files = await options.gateway.listFiles(options.activeManuscriptId);
        await options.openFile(options.activeManuscript?.rootPath ?? files[0]?.relativePath ?? "");
      }
    } catch (reason: unknown) { options.setError(errorMessage(reason)); }
  }

  return { createDirectory, createFile, deleteDirectory, deleteFile, refreshTree, renameDirectory, renameFile };
}

function isUnsaved(state: SaveState): boolean {
  return state === "dirty" || state === "error";
}

function pathIsWithin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function relocatePath(path: string, fromPath: string, toPath: string): string {
  return pathIsWithin(path, fromPath) ? `${toPath}${path.slice(fromPath.length)}` : path;
}

function updateManuscript(
  setManuscripts: Dispatch<SetStateAction<readonly Manuscript[]>>,
  updated: Manuscript,
): void {
  setManuscripts((current) => current.map((item) => item.id === updated.id ? updated : item));
}
