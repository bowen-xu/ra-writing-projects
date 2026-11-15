// @vitest-environment happy-dom
import {expect, it, vi} from "vitest";
import {parseManuscriptPath} from "@research-assistant/writing";
import {createBrowserWritingGateway} from "./browserWritingGateway";
import {memoryWritingRecords, memoryWritingState, registerWritingRecords} from "../../../../../../apps/web/src/app/runtime/testing/memoryWritingRecords";
import {createIndexedPreviewStorage} from "../../../../../../apps/web/src/core/runtime/previewIndexedStorage";
import {configurePreviewDatabase} from "../../../../../../apps/web/src/core/runtime/previewIndexedDatabase";
import {createMemoryPreviewDatabase} from "../../../../../../apps/web/src/app/runtime/testing/memoryPreviewDatabase";
import {flushStorage, storagePersistence} from "../../../../../../apps/web/src/core/runtime/storagePersistence";

function setup() {
  const state = memoryWritingState(), records = memoryWritingRecords(state);
  const storage: Storage = {length: 0, key: () => null, getItem: () => null, setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn()};
  registerWritingRecords(storage, records);
  return {state, records, storage, gateway: createBrowserWritingGateway(storage)};
}

it("does not silently hydrate or overwrite a legacy snapshot when the record authority is missing", () => {
  const storage: Storage = {length: 1, key: () => "writing-files", getItem: vi.fn(() => "preserved"), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn()};
  expect(() => createBrowserWritingGateway(storage)).toThrow("writing_storage_unavailable");
  expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
});

it("exposes the owning catalog without falling back to file or body enumeration", async () => {
  const {records, storage} = setup();
  const result = {items: [],revision: 7,pendingCount: 4,errorCount: 0,issues: []};
  const noteCatalog = {queryWritingNoteCatalog: vi.fn(async () => result),prepareWritingNoteCatalog: vi.fn(async () => ({processedCount:8,pendingCount:4,errorCount:0}))};
  Object.assign(records,{noteCatalog});
  const gateway = createBrowserWritingGateway(storage), query = {category:"all",view:"recent",limit:20} as const;
  await expect(gateway.noteCatalog!.queryWritingNoteCatalog(query)).resolves.toEqual(result);
  expect(noteCatalog.queryWritingNoteCatalog).toHaveBeenCalledWith(query);
  expect(records.reads).toEqual([]);
});

it("lists persisted headers without body reads, rehashing or read-side writes, including after reopen", async () => {
  const {records, storage, gateway} = setup();
  const project = await gateway.createManuscript({title: "Synthetic"});
  const body = await gateway.createFile(project.id, "notes/test.ranote", "正文".repeat(100_000));
  const modified = (await gateway.listFiles(project.id)).find(row => row.relativePath === body.relativePath);
  records.reads.length = 0;
  const hash = vi.spyOn(crypto.subtle, "digest"), reopened = createBrowserWritingGateway(storage);
  expect(await reopened.listManuscripts()).toEqual([project]);
  expect((await reopened.listFiles(project.id)).find(row => row.relativePath === body.relativePath)).toEqual(modified);
  expect(await reopened.listDirectories(project.id)).toEqual([{relativePath: "notes"}]);
  expect(records.reads.filter(row => row.store === "writingBodies")).toEqual([]);
  expect(hash).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); hash.mockRestore();
  records.reads.length = 0;
  expect(await reopened.readFile(project.id, body.relativePath)).toEqual(body);
  expect(records.reads.filter(row => row.store === "writingBodies")).toEqual([{store: "writingBodies", count: 1}]);
});

it("checks the current file hash and serializes concurrent saves without losing another file", async () => {
  const {gateway, storage} = setup(), project = await gateway.createManuscript({title: "CAS"});
  const a = await gateway.createFile(project.id, "a.tex", "a"), b = await gateway.createFile(project.id, "b.tex", "b");
  await Promise.all([gateway.saveFile({manuscriptId: project.id, relativePath: a.relativePath, content: "a2", expectedSha256: a.sha256}),
    gateway.saveFile({manuscriptId: project.id, relativePath: b.relativePath, content: "b2", expectedSha256: b.sha256})]);
  const reopened = createBrowserWritingGateway(storage);
  await expect(reopened.saveFile({manuscriptId: project.id, relativePath: a.relativePath, content: "stale", expectedSha256: a.sha256})).rejects.toMatchObject({code: "file_conflict"});
  expect((await reopened.readFile(project.id, a.relativePath)).content).toBe("a2");
  expect((await reopened.readFile(project.id, b.relativePath)).content).toBe("b2");
});

it("archives and deletes using headers, preserves other projects, and retains sessions and recovery through reopen", async () => {
  const {gateway, storage, records} = setup(), project = await gateway.createManuscript({title: "Delete"});
  const other = await gateway.createManuscript({title: "Keep"});
  await gateway.saveSession({manuscriptId: project.id, openPaths: [project.rootPath], activePath: project.rootPath, cursorState: {offset: 3}, layoutState: {split: true}});
  await gateway.saveRecoveryDraft({manuscriptId: project.id, relativePath: project.rootPath, content: "unsaved", baseSha256: "a".repeat(64)});
  const reopened = createBrowserWritingGateway(storage);
  expect(await reopened.getSession(project.id)).toMatchObject({activePath: "main.tex", cursorState: {offset: 3}});
  expect(await reopened.listRecoveryDrafts(project.id)).toMatchObject([{content: "unsaved"}]);
  await expect(reopened.deleteManuscript(project.id)).rejects.toThrow("先归档");
  records.reads.length = 0;
  await reopened.archiveManuscript(project.id); await reopened.restoreManuscript(project.id);
  await reopened.archiveManuscript(project.id); await reopened.deleteManuscript(project.id);
  expect(records.reads.filter(row => row.store === "writingBodies")).toEqual([]);
  expect(await reopened.listManuscripts()).toEqual([other]);
  expect(await reopened.getSession(project.id)).toBeUndefined(); expect(await reopened.listRecoveryDrafts(project.id)).toEqual([]);
});

it("retargets only selected file bodies on rename and deletes directories without reading them", async () => {
  const {gateway, records} = setup(), project = await gateway.createManuscript({title: "Move"});
  await gateway.createDirectory(project.id, "sections");
  const file = await gateway.createFile(project.id, "sections/a.tex", "keep");
  records.reads.length = 0;
  await gateway.renameDirectory(project.id, "sections", "chapters");
  expect(records.reads.filter(row => row.store === "writingBodies")).toEqual([{store: "writingBodies", count: 1}]);
  expect(await gateway.readFile(project.id, "chapters/a.tex")).toEqual({...file, relativePath: "chapters/a.tex"});
  await gateway.renameFile(project.id, "chapters/a.tex", "chapters/b.tex");
  records.reads.length = 0; await gateway.deleteDirectory(project.id, "chapters");
  expect(records.reads.filter(row => row.store === "writingBodies")).toEqual([]);
  expect((await gateway.listFiles(project.id)).map(row => row.relativePath)).toEqual([project.rootPath]);
});

it("rejects collisions, managed bibliography mutations, and malformed stored headers without replacing content", async () => {
  const {gateway, records, state} = setup(), project = await gateway.createManuscript({title: "Guard"});
  await gateway.createFile(project.id, "other.tex", "retained");
  await expect(gateway.renameFile(project.id, project.rootPath, "other.tex")).rejects.toThrow("文件已存在");
  await expect(gateway.createFile(project.id, "../other.tex", "bad")).rejects.toThrow();
  await expect(gateway.saveFile({manuscriptId: project.id, relativePath: parseManuscriptPath("refs.bib"), content: "raw"})).rejects.toMatchObject({code: "managed_bibliography"});
  records.reads.length = 0;
  for (const [key, value] of state.stores.get("writingFiles")!) state.stores.get("writingFiles")!.set(key, {...value as object, sizeBytes: -1});
  await expect(gateway.listFiles(project.id)).rejects.toMatchObject({code: "writing_storage_corrupt"});
  expect(records.reads.filter(row => row.store === "writingBodies")).toEqual([]);
});

it("joins preview flush/reset boundaries and does not acknowledge a failed file transaction", async () => {
  const database = createMemoryPreviewDatabase(); configurePreviewDatabase(database.open);
  const storage = await createIndexedPreviewStorage("writing-record-test:"), gateway = createBrowserWritingGateway(storage);
  const project = await gateway.createManuscript({title: "Receipt"}), original = await gateway.readFile(project.id, project.rootPath);
  database.failNext(new DOMException("disk full", "QuotaExceededError"));
  await expect(gateway.saveFile({manuscriptId: project.id, relativePath: project.rootPath, content: "new", expectedSha256: original.sha256})).rejects.toThrow("disk full");
  expect(await gateway.readFile(project.id, project.rootPath)).toEqual(original);
  let release!: () => void;
  database.holdUntil(new Promise<void>(resolve => { release = resolve; }));
  const port = storagePersistence(storage)!;
  const started = new Promise<void>(resolve => { const unsubscribe = port.subscribe(() => { if (port.pending) { unsubscribe(); resolve(); } }); });
  const save = gateway.saveFile({manuscriptId: project.id, relativePath: project.rootPath, content: "saved", expectedSha256: original.sha256});
  // Wait for the actual storage write, not an arbitrary timer.
  await started;
  let completed = false; const flush = flushStorage(storage).then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false); release(); await save; await flush;
  expect((await createBrowserWritingGateway(await createIndexedPreviewStorage("writing-record-test:")).readFile(project.id, project.rootPath)).content).toBe("saved");
  await storagePersistence(storage)!.reset();
  expect(await createBrowserWritingGateway(await createIndexedPreviewStorage("writing-record-test:")).listManuscripts()).toEqual([]);
  await expect(gateway.listFiles(project.id)).rejects.toThrow("closed");
});

it("duplicates all source files and folders atomically with independent identity and no recovery or session history", async()=>{
  const {gateway,storage}=setup();
  const source=await gateway.createManuscript({title:"Original"});
  await gateway.createDirectory(source.id,"empty");
  await gateway.createFile(source.id,"sections/a.tex","Original text");
  await gateway.saveSession({manuscriptId:source.id,openPaths:[parseManuscriptPath("main.tex")],activePath:parseManuscriptPath("main.tex"),cursorState:{},layoutState:{}});
  const copy=await gateway.duplicateManuscript!(source.id);
  expect(copy.id).not.toBe(source.id);expect(copy.title).toBe("Original（副本）");
  const reopened=createBrowserWritingGateway(storage);
  expect((await reopened.readFile(copy.id,"sections/a.tex")).content).toBe("Original text");
  expect((await reopened.listDirectories(copy.id)).map(row=>row.relativePath)).toContain("empty");
  expect(await reopened.getSession(copy.id)).toBeUndefined();expect(await reopened.listRecoveryDrafts(copy.id)).toEqual([]);
  const file=await reopened.readFile(copy.id,"sections/a.tex");
  await reopened.saveFile({manuscriptId:copy.id,relativePath:file.relativePath,expectedSha256:file.sha256,content:"Changed copy"});
  expect((await reopened.readFile(source.id,file.relativePath)).content).toBe("Original text");
});
