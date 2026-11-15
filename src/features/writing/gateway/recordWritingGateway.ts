import { classifyManuscriptFile, normalizeManuscriptDraft, parseManuscriptPath, type ManuscriptFileContent } from "@research-assistant/writing";
import { createBrowserBibliography, matchesBibliographyFile } from "./browserBibliography";
import { writingFileKey, type WritingRecordAccess, type WritingRecordChange, type WritingRecordSelection, type WritingRecordSnapshot } from "@research-assistant/workbench-sdk/writing-storage";
import { decodeWritingBody, decodeWritingDraft, decodeWritingFile, decodeWritingProject, decodeWritingSession, type StoredWritingProject } from "@research-assistant/workbench-sdk/writing-storage";
import type { WritingGateway } from "./writingGateway";

const projectSelection = (id: string): WritingRecordSelection => ({store: "writingProjects", keys: [id]});
const filesSelection = (id: string, paths?: readonly string[]): WritingRecordSelection => ({store: "writingFiles", ...(paths ? {keys: paths.map(path => writingFileKey(id, path))} : {manuscriptId: id})});
function project(snapshot: WritingRecordSnapshot, id: string): StoredWritingProject {
  const found = snapshot.rows.writingProjects?.map(decodeWritingProject).find(row => row.manuscript.id === id);
  if (!found) throw Object.assign(new Error("writing_project_missing：浏览器预览稿件不存在，请重新创建。"), {code: "writing_project_missing"});
  return found;
}
function editable(path: string): void {
  if (/\.bib$/iu.test(path)) throw Object.assign(new Error("BibTeX 由参考文献管理器维护，不能直接编辑。"), {code: "managed_bibliography"});
}
function within(path: string, directory: string): boolean { return path === directory || path.startsWith(`${directory}/`); }
function relocate(path: string, from: string, to: string): string { return within(path, from) ? to + path.slice(from.length) : path; }
function saveProject(value: StoredWritingProject): WritingRecordChange { return {store: "writingProjects", key: value.manuscript.id, value}; }
async function fileChanges(id: string, path: string, content: string, modifiedAt = new Date().toISOString()): Promise<{file: ManuscriptFileContent; changes: WritingRecordChange[]}> {
  const relativePath = parseManuscriptPath(path), bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const file = {relativePath, content, sha256}, key = writingFileKey(id, relativePath);
  return {file, changes: [{store: "writingFiles", key, value: {manuscriptId: id, relativePath, sha256, modifiedAt, sizeBytes: bytes.length, kind: classifyManuscriptFile(relativePath)}},
    {store: "writingBodies", key, value: file}]};
}

/** Async file authority. List operations read persisted headers only; the
 * database owns content and CAS, while opened editors keep their own sessions. */
export function createRecordWritingGateway(records: WritingRecordAccess, fallback: WritingGateway, storage: Storage,
  initialBibliography: readonly {readonly path: string; readonly content: string}[] = []): WritingGateway {
  let pending: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation); pending = result.catch(() => undefined); return result;
  }
  async function writeFile(id: string, path: string, content: string, options: {create?: boolean; expectedSha256?: string} = {}) {
    const relativePath = parseManuscriptPath(path);
    const snapshot = await records.read([projectSelection(id), filesSelection(id, [relativePath])]); project(snapshot, id);
    const previous = snapshot.rows.writingFiles?.map(decodeWritingFile)[0];
    if (options.create && previous) throw new Error("文件已存在");
    if (options.expectedSha256 !== undefined && previous?.sha256 !== options.expectedSha256)
      throw Object.assign(new Error("文件已发生变化，请重新载入"), {code: "file_conflict"});
    const result = await fileChanges(id, relativePath, content);
    await records.commit(snapshot.revision, result.changes); return result.file;
  }
  const gateway: WritingGateway = {
    ...fallback,
    duplicateManuscript: id => serialized(async () => {
      const snapshot = await records.read([projectSelection(id), filesSelection(id)]);
      const headers = (snapshot.rows.writingFiles ?? []).map(decodeWritingFile);
      const contents = await records.read([{store:"writingBodies",keys:headers.map(file=>writingFileKey(id,file.relativePath))}]);
      if(contents.revision!==snapshot.revision)throw new Error("writing_revision_conflict：稿件已变化，请重试复制");
      const source = project(snapshot,id), nextId = crypto.randomUUID(), now = new Date().toISOString();
      const manuscript = {...source.manuscript,id:nextId,title:`${source.manuscript.title.slice(0,175)}（副本）`,status:"active" as const,createdAt:now,updatedAt:now};
      const bodies = new Map((contents.rows.writingBodies ?? []).map(decodeWritingBody).map(body=>[body.relativePath,body]));
      const changes: WritingRecordChange[] = [saveProject({...source,manuscript})];
      for(const file of headers) {
        const body = bodies.get(file.relativePath);
        if(!body || body.sha256!==file.sha256)throw new Error("writing_storage_corrupt：复制失败，正文与元数据不一致");
        const key=writingFileKey(nextId,file.relativePath);
        changes.push({store:"writingFiles",key,value:{...file,manuscriptId:nextId,modifiedAt:now}},{store:"writingBodies",key,value:body});
      }
      await records.commit(snapshot.revision,changes); return manuscript;
    }),
    ...(records.noteCatalog ? {noteCatalog: records.noteCatalog} : {}),
    listManuscripts: () => serialized(async () => (await records.read([{store: "writingProjects"}])).rows.writingProjects?.map(decodeWritingProject).map(row => row.manuscript) ?? []),
    createManuscript: draft => serialized(async () => {
      const input = normalizeManuscriptDraft(draft), id = crypto.randomUUID(), timestamp = new Date().toISOString();
      const value: StoredWritingProject = {manuscript: {id, title: input.title, rootPath: input.rootPath, status: "active", createdAt: timestamp, updatedAt: timestamp}, directories: []};
      const snapshot = await records.read([]);
      const root = await fileChanges(id, input.rootPath, `\\documentclass{article}\n\\title{${input.title.replace(/[{}]/g, "")}}\n\\begin{document}\n\\maketitle\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n`, timestamp);
      const changes = [saveProject(value), ...root.changes];
      for (const file of initialBibliography) changes.push(...(await fileChanges(id, file.path, file.content, timestamp)).changes);
      await records.commit(snapshot.revision, changes); return value.manuscript;
    }),
    archiveManuscript: id => changeProject(id, value => ({...value, manuscript: {...value.manuscript, status: "archived", updatedAt: new Date().toISOString()}})),
    restoreManuscript: id => changeProject(id, value => ({...value, manuscript: {...value.manuscript, status: "active", updatedAt: new Date().toISOString()}})),
    updateManuscript: request => changeProject(request.manuscriptId, value => ({...value, manuscript: {...value.manuscript,
      ...(request.title === undefined ? {} : {title: request.title.trim()}), ...(request.rootPath === undefined ? {} : {rootPath: parseManuscriptPath(request.rootPath)}), updatedAt: new Date().toISOString()}})),
    deleteManuscript: id => serialized(async () => {
      const snapshot = await records.read([projectSelection(id), filesSelection(id), {store: "writingDrafts", manuscriptId: id}]);
      if (project(snapshot, id).manuscript.status !== "archived") throw new Error("请先归档稿件，再永久删除");
      const changes: WritingRecordChange[] = [{store: "writingProjects", key: id}, {store: "writingSessions", key: id}];
      for (const file of snapshot.rows.writingFiles?.map(decodeWritingFile) ?? []) changes.push({store: "writingFiles", key: writingFileKey(id, file.relativePath)}, {store: "writingBodies", key: writingFileKey(id, file.relativePath)});
      for (const draft of snapshot.rows.writingDrafts?.map(decodeWritingDraft) ?? []) changes.push({store: "writingDrafts", key: writingFileKey(id, draft.relativePath)});
      await records.commit(snapshot.revision, changes);
    }),
    listFiles: id => serialized(async () => {
      const snapshot = await records.read([projectSelection(id), filesSelection(id)]); project(snapshot, id);
      return snapshot.rows.writingFiles?.map(decodeWritingFile) ?? [];
    }),
    readFile: (id, path) => serialized(async () => {
      const key = writingFileKey(id, parseManuscriptPath(path));
      const snapshot = await records.read([projectSelection(id), filesSelection(id, [path]), {store: "writingBodies", keys: [key]}]); project(snapshot, id);
      const header = snapshot.rows.writingFiles?.map(decodeWritingFile)[0], value = snapshot.rows.writingBodies?.[0];
      if (!header || value === undefined) throw Object.assign(new Error("writing_file_missing：稿件文件不存在。"), {code: "writing_file_missing"});
      const file = decodeWritingBody(value);
      if (file.relativePath !== header.relativePath || file.sha256 !== header.sha256) throw Object.assign(new Error("writing_storage_corrupt：文件正文与元数据不一致，原记录已保留。"), {code: "writing_storage_corrupt"});
      return file;
    }),
    saveFile: request => serialized(async () => { editable(request.relativePath); return writeFile(request.manuscriptId, request.relativePath, request.content, request); }),
    createFile: (id, path, content = "") => serialized(async () => { editable(parseManuscriptPath(path)); return writeFile(id, path, content, {create: true}); }),
    renameFile: (id, from, to) => serialized(async () => {
      from = parseManuscriptPath(from); to = parseManuscriptPath(to); editable(from); editable(to);
      const key = writingFileKey(id, from);
      const snapshot = await records.read([projectSelection(id), filesSelection(id, [from, to]), {store: "writingBodies", keys: [key]}]);
      const current = project(snapshot, id), files = snapshot.rows.writingFiles?.map(decodeWritingFile) ?? [];
      const file = files.find(file => file.relativePath === from), body = snapshot.rows.writingBodies?.[0];
      if (!file || body === undefined) throw new Error("稿件文件不存在");
      if (from === to) return current.manuscript;
      if (files.some(file => file.relativePath === to)) throw new Error("文件已存在");
      const moved: StoredWritingProject = {...current, manuscript: {...current.manuscript, rootPath: current.manuscript.rootPath === from ? parseManuscriptPath(to) : current.manuscript.rootPath}};
      await records.commit(snapshot.revision, [saveProject(moved), {store: "writingFiles", key}, {store: "writingBodies", key},
        {store: "writingFiles", key: writingFileKey(id, to), value: {...file, relativePath: to, modifiedAt: new Date().toISOString()}},
        {store: "writingBodies", key: writingFileKey(id, to), value: {...decodeWritingBody(body), relativePath: to}}]);
      return moved.manuscript;
    }),
    deleteFile: (id, path) => serialized(async () => {
      path = parseManuscriptPath(path); editable(path);
      const snapshot = await records.read([projectSelection(id)]); project(snapshot, id);
      await records.commit(snapshot.revision, [{store: "writingFiles", key: writingFileKey(id, path)}, {store: "writingBodies", key: writingFileKey(id, path)}]);
    }),
    listDirectories: id => serialized(async () => {
      const snapshot = await records.read([projectSelection(id), filesSelection(id)]), paths = new Set(project(snapshot, id).directories);
      for (const file of snapshot.rows.writingFiles?.map(decodeWritingFile) ?? []) {
        const parts = file.relativePath.split("/"); for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join("/"));
      }
      return [...paths].sort().map(path => ({relativePath: parseManuscriptPath(path)}));
    }),
    createDirectory: (id, path) => serialized(async () => {
      const relativePath = parseManuscriptPath(path), snapshot = await records.read([projectSelection(id)]), value = project(snapshot, id);
      if (value.directories.includes(relativePath)) throw new Error("目录已存在");
      await records.commit(snapshot.revision, [saveProject({...value, directories: [...value.directories, relativePath]})]); return {relativePath};
    }),
    renameDirectory: (id, from, to) => moveDirectory(id, from, to),
    deleteDirectory: async (id, path) => { await moveDirectory(id, path); },
    saveSession: draft => serialized(async () => {
      const snapshot = await records.read([]), session = decodeWritingSession({...draft, updatedAt: new Date().toISOString()});
      await records.commit(snapshot.revision, [{store: "writingSessions", key: draft.manuscriptId, value: session}]);
    }),
    getSession: id => serialized(async () => {
      const value = (await records.read([{store: "writingSessions", keys: [id]}])).rows.writingSessions?.[0];
      return value === undefined ? undefined : decodeWritingSession(value);
    }),
    saveRecoveryDraft: draft => serialized(async () => {
      const snapshot = await records.read([]), saved = decodeWritingDraft({...draft, updatedAt: new Date().toISOString()});
      await records.commit(snapshot.revision, [{store: "writingDrafts", key: writingFileKey(draft.manuscriptId, draft.relativePath), value: saved}]); return saved;
    }),
    listRecoveryDrafts: id => serialized(async () => (await records.read([{store: "writingDrafts", manuscriptId: id}])).rows.writingDrafts?.map(decodeWritingDraft) ?? []),
    clearRecoveryDraft: (id, path) => serialized(async () => {
      const snapshot = await records.read([]); await records.commit(snapshot.revision, [{store: "writingDrafts", key: writingFileKey(id, path)}]);
    }),
  };
  function changeProject(id: string, transform: (value: StoredWritingProject) => StoredWritingProject) {
    return serialized(async () => { const snapshot = await records.read([projectSelection(id)]), value = transform(project(snapshot, id));
      await records.commit(snapshot.revision, [saveProject(value)]); return value.manuscript; });
  }
  function moveDirectory(id: string, from: string, to?: string) {
    return serialized(async () => {
      from = parseManuscriptPath(from); if (to !== undefined) to = parseManuscriptPath(to);
      if (to && (to === from || within(to, from))) throw new Error("目标目录不能位于原目录内");
      const snapshot = await records.read([projectSelection(id), filesSelection(id)]), current = project(snapshot, id);
      const files = snapshot.rows.writingFiles?.map(decodeWritingFile) ?? [], affected = files.filter(file => within(file.relativePath, from));
      for (const file of affected) editable(file.relativePath);
      if (!to && within(current.manuscript.rootPath, from)) throw new Error("不能删除包含根文档的目录");
      const changes: WritingRecordChange[] = [];
      const revision = snapshot.revision, destination = to;
      // Only moves need selected bodies. Deletion works entirely from headers.
      if (to) {
        const bodies = await records.read([{store: "writingBodies", keys: affected.map(file => writingFileKey(id, file.relativePath))}]);
        if (bodies.revision !== revision) throw Object.assign(new Error("writing_revision_conflict：目录内容已变化，请重新读取。"), {code: "writing_revision_conflict"});
        const values = new Map(bodies.rows.writingBodies?.map(decodeWritingBody).map(file => [file.relativePath, file]));
        for (const file of affected) {
          const path = parseManuscriptPath(relocate(file.relativePath, from, to)), body = values.get(file.relativePath);
          if (!body || body.sha256 !== file.sha256) throw new Error("writing_storage_corrupt：目录文件正文缺失或不一致。");
          if (files.some(existing => existing.relativePath === path)) throw new Error("目标目录中已有同名文件");
          changes.push({store: "writingFiles", key: writingFileKey(id, path), value: {...file, relativePath: path}},
            {store: "writingBodies", key: writingFileKey(id, path), value: {...body, relativePath: path}});
        }
      }
      for (const file of affected) changes.push({store: "writingFiles", key: writingFileKey(id, file.relativePath)}, {store: "writingBodies", key: writingFileKey(id, file.relativePath)});
      const next: StoredWritingProject = {...current, directories: destination ? current.directories.map(path => relocate(path, from, destination)) : current.directories.filter(path => !within(path, from)),
        manuscript: {...current.manuscript, rootPath: to ? parseManuscriptPath(relocate(current.manuscript.rootPath, from, to)) : current.manuscript.rootPath}};
      changes.push(saveProject(next)); await records.commit(revision, changes); return next.manuscript;
    });
  }
  const bibliography = createBrowserBibliography(storage, {
    list: async (id,kind) => {
      const files = (await gateway.listFiles(id)).filter(file => matchesBibliographyFile(file.relativePath,kind));
      return Promise.all(files.map(file => gateway.readFile(id, file.relativePath)));
    },
    stat: (id,path) => serialized(async () => {
      const snapshot = await records.read([projectSelection(id),filesSelection(id,[parseManuscriptPath(path)])]);
      project(snapshot,id);
      return snapshot.rows.writingFiles?.map(decodeWritingFile)[0];
    }),
    write: (id, path, content) => serialized(async () => { await writeFile(id, path, content); }),
  });
  return {...gateway, ...bibliography};
}
