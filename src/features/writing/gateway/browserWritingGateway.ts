import { writingRecords } from "@research-assistant/workbench-sdk/writing-storage";
import { createRecordWritingGateway } from "./recordWritingGateway";
import { createBrowserBibliography, matchesBibliographyFile } from "./browserBibliography";
import {
  classifyManuscriptFile,
  normalizeManuscriptDraft,
  parseManuscriptPath,
  type Manuscript,
  type ManuscriptDraft,
  type ManuscriptFile,
  type ManuscriptFileContent,
  type SaveManuscriptFileRequest,
  type RecoveryDraft,
  type WritingSession,
  type ManuscriptDirectory,
} from "@research-assistant/writing";

import type { WritingGateway } from "./writingGateway";

interface BrowserManuscript {
  manuscript: Manuscript;
  files: Map<string, ManuscriptFileContent>;
  directories: Set<string>;
  editedAt?: Map<string, string>;
}

export function createBrowserWritingGateway(storage?: Storage, options: { readonly initialBibliography?: readonly {readonly path: string;readonly content: string}[] } = {}): WritingGateway {
const records = storage && writingRecords(storage);
if (records && storage) return createRecordWritingGateway(records, createBrowserWritingGateway(), storage, options.initialBibliography);
if (storage) throw Object.assign(new Error("writing_storage_unavailable：写作存储尚未绑定，未读取或覆盖旧快照。"), {code: "writing_storage_unavailable"});
const manuscripts = new Map<string, BrowserManuscript>();
const writingSessions = new Map<string, WritingSession>();
const recoveryDrafts = new Map<string, RecoveryDraft>();

async function hashText(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function findManuscript(manuscriptId: string): BrowserManuscript {
  const value = manuscripts.get(manuscriptId);
  if (value === undefined) throw new Error("浏览器预览稿件不存在，请重新创建");
  return value;
}

function isWithin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function relocatePath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath;
  return path.startsWith(`${fromPath}/`)
    ? `${toPath}/${path.slice(fromPath.length + 1)}`
    : path;
}

function editable(path: string): void {
 if (/\.bib$/iu.test(path.trim())) throw Object.assign(new Error("BibTeX 由参考文献管理器维护，不能直接编辑。"),{code:"managed_bibliography"});
}
function editableDirectory(id: string, directory: string): void {
 for (const path of findManuscript(id).files.keys()) if (isWithin(path,directory)) editable(path);
}
const bibliography = createBrowserBibliography(storage, {
 list: (id,kind) => [...findManuscript(id).files.values()].filter(file => matchesBibliographyFile(file.relativePath,kind)),
 stat: (id,path) => findManuscript(id).files.get(path),
 write: async (id,path,content) => { findManuscript(id).files.set(path,{relativePath:parseManuscriptPath(path),content,sha256:await hashText(content)}); },
});
const gateway: WritingGateway = {
  async duplicateManuscript(manuscriptId) {
    const source=findManuscript(manuscriptId), now=new Date().toISOString(), id=crypto.randomUUID();
    const manuscript={...source.manuscript,id,title:`${source.manuscript.title.slice(0,175)}（副本）`,status:"active" as const,createdAt:now,updatedAt:now};
    manuscripts.set(id,{manuscript,files:new Map([...source.files].map(([path,file])=>[path,{...file}])),directories:new Set(source.directories)});
    return manuscript;
  },
  supportsCompilation: false,
  async listManuscripts() {
    return Array.from(manuscripts.values())
      .map((value) => value.manuscript);
  },
  async createManuscript(input: ManuscriptDraft) {
    const draft = normalizeManuscriptDraft(input);
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const manuscript: Manuscript = {
      id,
      title: draft.title,
      rootPath: draft.rootPath,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const content = `\\documentclass{article}\n\\title{${draft.title.replace(/[{}]/g, "")}}\n\\begin{document}\n\\maketitle\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n`;
    const sha256 = await hashText(content);
    manuscripts.set(id, {
      manuscript,
      files: new Map([[draft.rootPath, { relativePath: draft.rootPath, content, sha256 }]]),
      directories: new Set(),
      editedAt: new Map([[draft.rootPath, timestamp]]),
    });
    for (const file of options.initialBibliography ?? []) {
      findManuscript(id).files.set(file.path,{relativePath:parseManuscriptPath(file.path),content:file.content,sha256:await hashText(file.content)});
    }
    return manuscript;
  },
  async archiveManuscript(manuscriptId) {
    const current = findManuscript(manuscriptId);
    const manuscript: Manuscript = { ...current.manuscript, status: "archived", updatedAt: new Date().toISOString() };
    manuscripts.set(manuscriptId, { ...current, manuscript });
    return manuscript;
  },
  async deleteManuscript(manuscriptId) {
    if (findManuscript(manuscriptId).manuscript.status !== "archived") throw new Error("请先归档稿件，再永久删除");
    manuscripts.delete(manuscriptId);
    writingSessions.delete(manuscriptId);
    for (const [key, draft] of recoveryDrafts) if (draft.manuscriptId === manuscriptId) recoveryDrafts.delete(key);
  },
  async restoreManuscript(manuscriptId) {
    const current = findManuscript(manuscriptId);
    const manuscript: Manuscript = { ...current.manuscript, status: "active", updatedAt: new Date().toISOString() };
    manuscripts.set(manuscriptId, { ...current, manuscript });
    return manuscript;
  },
  async updateManuscript(request) {
    const current = findManuscript(request.manuscriptId);
    const manuscript = {
      ...current.manuscript,
      ...(request.title === undefined ? {} : { title: request.title.trim() }),
      ...(request.rootPath === undefined ? {} : { rootPath: parseManuscriptPath(request.rootPath) }),
      updatedAt: new Date().toISOString(),
    };
    manuscripts.set(request.manuscriptId, { ...current, manuscript });
    return manuscript;
  },
  async listFiles(manuscriptId) {
    const current = findManuscript(manuscriptId);
    const timestamp = current.manuscript.updatedAt;
    return Promise.all(Array.from(current.files.values()).map(async (file): Promise<ManuscriptFile> => ({
      manuscriptId,
      relativePath: file.relativePath,
      kind: classifyManuscriptFile(file.relativePath),
      sizeBytes: new TextEncoder().encode(file.content).length,
      sha256: await hashText(file.content),
      modifiedAt: current.editedAt?.get(file.relativePath) ?? timestamp,
    })));
  },
  async readFile(manuscriptId, relativePath) {
    const file = findManuscript(manuscriptId).files.get(relativePath);
    if (file === undefined) throw new Error("稿件文件不存在");
    return file;
  },
  async saveFile(request: SaveManuscriptFileRequest) {
    editable(request.relativePath);
    const current = findManuscript(request.manuscriptId);
    const existing = current.files.get(request.relativePath);
    if (request.expectedSha256 !== undefined && existing?.sha256 !== request.expectedSha256) {
      throw Object.assign(new Error("文件已发生变化，请重新载入"), { code: "file_conflict" });
    }
    const content: ManuscriptFileContent = {
      relativePath: parseManuscriptPath(request.relativePath),
      content: request.content,
      sha256: await hashText(request.content),
    };
    current.files.set(request.relativePath, content);
    (current.editedAt ??= new Map()).set(request.relativePath, new Date().toISOString());
    return content;
  },
  async createFile(manuscriptId, relativePath, content = "") {
    const current = findManuscript(manuscriptId);
    const path = parseManuscriptPath(relativePath);
    editable(path);
    if (current.files.has(path)) throw new Error("文件已存在");
    const file = { relativePath: path, content, sha256: await hashText(content) };
    current.files.set(path, file);
    (current.editedAt ??= new Map()).set(path, new Date().toISOString());
    return file;
  },
  async renameFile(manuscriptId, fromPath, toPath) {
    const current = findManuscript(manuscriptId);
    const from = parseManuscriptPath(fromPath);
    const to = parseManuscriptPath(toPath);
    editable(from); editable(to);
    const file = current.files.get(from);
    if (file === undefined) throw new Error("稿件文件不存在");
    current.files.delete(from);
    current.files.set(to, { ...file, relativePath: to });
    (current.editedAt ??= new Map()).set(to, new Date().toISOString());
    current.editedAt.delete(from);
    if (current.manuscript.rootPath === from) {
      current.manuscript = { ...current.manuscript, rootPath: to };
    }
    return current.manuscript;
  },
  async deleteFile(manuscriptId, relativePath) {
    editable(relativePath);
    findManuscript(manuscriptId).files.delete(parseManuscriptPath(relativePath));
  },
  async listDirectories(manuscriptId) {
    const current = findManuscript(manuscriptId);
    const paths = new Set(current.directories);
    for (const path of current.files.keys()) {
      const components = path.split("/");
      for (let index = 1; index < components.length; index += 1) {
        paths.add(components.slice(0, index).join("/"));
      }
    }
    return [...paths].sort().map((relativePath): ManuscriptDirectory => ({
      relativePath: parseManuscriptPath(relativePath),
    }));
  },
  async createDirectory(manuscriptId, relativePath) {
    const current = findManuscript(manuscriptId);
    const path = parseManuscriptPath(relativePath);
    if (current.directories.has(path)) throw new Error("目录已存在");
    current.directories.add(path);
    return { relativePath: path };
  },
  async renameDirectory(manuscriptId, fromPath, toPath) {
    const current = findManuscript(manuscriptId);
    const from = parseManuscriptPath(fromPath);
    const to = parseManuscriptPath(toPath);
    editableDirectory(manuscriptId,from);
    const relocatedFiles = [...current.files.entries()]
      .filter(([path]) => isWithin(path, from));
    for (const [path, file] of relocatedFiles) {
      current.files.delete(path);
      const nextPath = relocatePath(path, from, to);
      current.files.set(nextPath, { ...file, relativePath: parseManuscriptPath(nextPath) });
      if (current.editedAt?.has(path)) { current.editedAt.set(nextPath, current.editedAt.get(path)!); current.editedAt.delete(path); }
    }
    current.directories = new Set([...current.directories].map((path) => relocatePath(path, from, to)));
    current.manuscript = {
      ...current.manuscript,
      rootPath: parseManuscriptPath(relocatePath(current.manuscript.rootPath, from, to)),
    };
    return current.manuscript;
  },
  async deleteDirectory(manuscriptId, relativePath) {
    const current = findManuscript(manuscriptId);
    const path = parseManuscriptPath(relativePath);
    editableDirectory(manuscriptId,path);
    if (isWithin(current.manuscript.rootPath, path)) throw new Error("不能删除包含根文档的目录");
    for (const file of current.files.keys()) {
      if (isWithin(file, path)) current.files.delete(file);
    }
    current.directories = new Set([...current.directories].filter((directory) => !isWithin(directory, path)));
  },
  async importResources() {
    throw new Error("资源上传只在 Tauri 桌面模式中可用");
  },
  async saveSession(draft) {
    writingSessions.set(draft.manuscriptId, { ...structuredClone(draft), updatedAt: new Date().toISOString() });
  },
  async getSession(manuscriptId) {
    return writingSessions.get(manuscriptId);
  },
  async saveRecoveryDraft(draft) {
    const saved = { ...draft, updatedAt: new Date().toISOString() };
    recoveryDrafts.set(`${draft.manuscriptId}:${draft.relativePath}`, saved);
    return saved;
  },
  async listRecoveryDrafts(manuscriptId) {
    return [...recoveryDrafts.values()].filter((draft) => draft.manuscriptId === manuscriptId);
  },
  async clearRecoveryDraft(manuscriptId, relativePath) {
    recoveryDrafts.delete(`${manuscriptId}:${relativePath}`);
  },
  async previewImport() {
    throw new Error("工程导入预检只在 Tauri 桌面模式中可用");
  },
  async importProject() {
    throw new Error("工程导入只在 Tauri 桌面模式中可用");
  },
  async exportSource() {
    throw new Error("工程 ZIP 导出只在 Tauri 桌面模式中可用");
  },
  async exportPdf() {
    throw new Error("PDF 导出只在 Tauri 桌面模式中可用");
  },
  async forwardSynctex() {
    throw new Error("SyncTeX 只在 Tauri 桌面模式中可用");
  },
  async inverseSynctex() {
    throw new Error("SyncTeX 只在 Tauri 桌面模式中可用");
  },
  async detectToolchain() {
    return { available: false, tools: [], supportedEngines: [], checkedAt: new Date().toISOString() };
  },
  async startCompile() {
    throw new Error("浏览器预览不支持 LaTeX 编译，请使用桌面应用");
  },
  async getCompileRun() {
    throw new Error("浏览器预览没有编译任务");
  },
  async getLatestCompileRun() {
    return undefined;
  },
  async getLatestPdfCompileRun() {
    return undefined;
  },
  async isCompileCurrent() {
    return false;
  },
  async cancelCompile() {
    throw new Error("浏览器预览没有可取消的编译任务");
  },
  async readCompilePdf() {
    throw new Error("浏览器预览没有编译产物");
  },
  ...bibliography,
};

return gateway;
}

export const browserWritingGateway = createBrowserWritingGateway();
