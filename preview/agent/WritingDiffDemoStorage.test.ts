import { afterEach, expect, it, vi } from "vitest";
import { WritingDiffDemoStorage } from "./WritingDiffDemoStorage";
import { initialChanges } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import { WritingFileSessions } from "../../src/features/writing/editor/writingFileSessions";
import { WritingCheckpointPersistence } from "../../src/features/writing/persistence/WritingCheckpointPersistence";
import { WritingFileSaveQueue } from "../../src/features/writing/persistence/WritingFileSaveQueue";
import { prepareWritingClose } from "../../src/features/writing/persistence/writingCloseBoundary";

const manuscriptId = "00000000-0000-4000-8000-000000000003";
const disconnects: (() => void)[] = [];
afterEach(() => { for (const disconnect of disconnects.splice(0)) disconnect(); });
async function open(storage: WritingDiffDemoStorage, seed = false) {
  const files = new WritingFileSessions(), errors = vi.fn();
  const checkpoints = new WritingCheckpointPersistence(files, storage.checkpoints, errors);
  const saves = new WritingFileSaveQueue(files, checkpoints, storage.files, errors);
  const disconnectCheckpoints = checkpoints.connect(), disconnectSaves = saves.connect();
  const disconnect = () => { disconnectSaves(); disconnectCheckpoints(); };
  disconnects.push(disconnect);
  for (const change of initialChanges) {
    await checkpoints.open(manuscriptId, await storage.files.readFile(manuscriptId, change.path));
  }
  if (seed) for (const change of initialChanges) {
    const file = files.get({ manuscriptId, relativePath: change.path })!;
    file.applyAgent("fixture-completion", file.read().version, change.after);
  }
  const close = (onRecoverable = vi.fn(), onFailure = vi.fn()) => prepareWritingClose({ saves, checkpoints,
    flushSession: async () => undefined, onRecoverable, onFailure });
  return { files, saves, checkpoints, close, disconnect, errors };
}
it("keeps formal files and recovery records independent and restores partial review in new sessions", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges), first = await open(storage, true);
  first.files.get({ manuscriptId, relativePath: "main.tex" })!.resolveAll("keep");
  expect(await first.close()).toBe(true);
  first.disconnect();
  const second = await open(storage);
  expect(second.files).not.toBe(first.files);
  for (const change of initialChanges) {
    const file = second.files.get({ manuscriptId, relativePath: change.path })!;
    expect(file.read().content).toBe(change.after);
    expect(file.pending).toBe(change.path !== "main.tex");
    expect((await storage.files.readFile(manuscriptId, change.path)).content).toBe(change.after);
  }
  expect(await second.close()).toBe(true);
});
it("recovers kept text from checkpoints after failed formal saves without depending on history", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges), first = await open(storage);
  storage.fault = "file";
  const main = first.files.get({ manuscriptId, relativePath: "main.tex" })!;
  main.applyAgent("fixture-completion", main.read().version, initialChanges[0]!.after);
  main.resolveAll("keep");
  const onRecoverable = vi.fn();
  expect(await first.close(onRecoverable)).toBe(true);
  expect(onRecoverable).toHaveBeenCalledOnce();
  expect((await storage.files.readFile(manuscriptId, "main.tex")).content).toBe(initialChanges[0]!.before);
  first.disconnect();
  const second = await open(storage);
  const restored = second.files.get(main.identity)!;
  expect(restored.read()).toMatchObject({ content: initialChanges[0]!.after, reviewBaseline: initialChanges[0]!.after });
  expect(restored.pending).toBe(false); expect(second.checkpoints.isSaved(main.identity)).toBe(false);
  storage.fault = "none";
  await second.saves.save(main.identity);
  expect(second.checkpoints.isSaved(main.identity)).toBe(true);
  expect((await storage.files.readFile(manuscriptId, "main.tex")).content).toBe(initialChanges[0]!.after);
});
it("blocks close when neither files nor checkpoints can preserve a new Keep decision", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges), host = await open(storage);
  storage.fault = "both";
  const file = host.files.get({ manuscriptId, relativePath: "main.tex" })!;
  file.applyAgent("fixture-completion", file.read().version, initialChanges[0]!.after); file.resolveAll("keep");
  const onFailure = vi.fn();
  expect(await host.close(vi.fn(), onFailure)).toBe(false);
  expect(onFailure).toHaveBeenCalledOnce(); expect(file.read().content).toBe(initialChanges[0]!.after);
  storage.fault = "none";
  expect(await host.close()).toBe(true);
});
it("detects external disk changes without changing either the draft or review baseline", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges), host = await open(storage);
  const file = host.files.get({ manuscriptId, relativePath: "main.tex" })!;
  const release = await host.saves.pause();
  file.applyAgent("fixture-completion", file.read().version, initialChanges[0]!.after);
  await storage.externalEdit("main.tex", "% changed outside editor"); release();
  await expect(host.saves.save(file.identity)).rejects.toMatchObject({ code: "file_conflict" });
  expect((await storage.files.readFile(manuscriptId, "main.tex")).content).toBe("% changed outside editor");
  expect(file.read()).toMatchObject({ content: initialChanges[0]!.after, reviewBaseline: initialChanges[0]!.before });
  expect(await host.close()).toBe(true);
  const restored = await open(storage).catch((reason: unknown) => reason);
  expect(restored).toMatchObject({ code: "file_conflict" });
});
it("creates conflict copies without overwriting an existing file and lists persisted copy bytes", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges);
  const path = "main-conflict-copy.tex";
  const created = await storage.files.createFile(manuscriptId, path, "% kept copy\n");
  await expect(storage.files.createFile(manuscriptId, path, "replacement")).rejects.toThrow("已存在");
  expect(await storage.files.readFile(manuscriptId, path)).toEqual(created);
  expect(await storage.files.listFiles(manuscriptId)).toContainEqual(expect.objectContaining({ relativePath: path,
    sha256: created.sha256, sizeBytes: new TextEncoder().encode(created.content).byteLength }));
  storage.fault = "file";
  await expect(storage.files.createFile(manuscriptId, "failed-copy.tex", "draft")).rejects.toThrow("保存失败");
  expect((await storage.files.listFiles(manuscriptId)).map((file) => file.relativePath)).not.toContain("failed-copy.tex");
});

it("recovers a committed file with a lost reply in new production sessions without another file write", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges), first = await open(storage, true);
  expect(await first.close()).toBe(true);
  const save = vi.spyOn(storage.files, "saveFile"), main = first.files.get({ manuscriptId, relativePath: "main.tex" })!;
  storage.fault = "fileReceipt";
  main.resolveAll("keep");
  main.dispatch({ changes: { from: main.state.doc.length, insert: "\n% later input" }, userEvent: "input.type" });
  await vi.waitFor(() => expect(first.errors).toHaveBeenCalledWith(expect.objectContaining({ message: "模拟正式文件已写入但回执丢失" }), main.identity));
  expect((await storage.files.readFile(manuscriptId, "main.tex")).content).toBe(main.read().content);
  expect((await storage.checkpoints.list(manuscriptId)).find(row => row.checkpoint.relativePath === "main.tex")?.checkpoint.saveIntent).toBeTruthy();
  const snapshot = main.read(); first.disconnect();
  const restored = await open(storage), next = restored.files.get(main.identity)!;
  expect(next.read()).toEqual(snapshot);
  expect(next.pending).toBe(false);
  expect(restored.files.get({ manuscriptId, relativePath: "sections/introduction.tex" })!.pending).toBe(true);
  expect(restored.checkpoints.isSaved(main.identity)).toBe(true);
  expect((await storage.checkpoints.list(manuscriptId)).find(row => row.checkpoint.relativePath === "main.tex")?.checkpoint.saveIntent).toBeNull();
  expect(await restored.close()).toBe(true);
  expect(save).toHaveBeenCalledOnce();
});

it("retries a committed checkpoint receipt before advancing Keep and restores both D and B", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges), first = await open(storage, true);
  expect(await first.close()).toBe(true);
  const save = vi.spyOn(storage.checkpoints, "save"), main = first.files.get({ manuscriptId, relativePath: "main.tex" })!;
  storage.fault = "checkpointReceipt";
  main.dispatch({ changes: { from: main.state.doc.length, insert: "\n% unsaved latest" }, userEvent: "input.type" });
  await expect(first.checkpoints.flush(main.identity)).rejects.toThrow("模拟检查点已写入但回执丢失");
  main.resolveAll("keep");
  expect(await first.close()).toBe(true);
  expect(save.mock.calls[1]?.[0]).toEqual(save.mock.calls[0]?.[0]);
  const snapshot = main.read(); first.disconnect();
  const restored = await open(storage), next = restored.files.get(main.identity)!;
  expect(next.read()).toEqual(snapshot);
  expect(next.pending).toBe(false);
  expect(restored.checkpoints.isSaved(main.identity)).toBe(true);
});

it("drains later edits and Keep during delayed durable replies before close and recovery", async () => {
  const storage = new WritingDiffDemoStorage(manuscriptId, initialChanges), first = await open(storage, true);
  expect(await first.close()).toBe(true);
  storage.ioDelayMs = 30; storage.fault = "delayed";
  const main = first.files.get({ manuscriptId, relativePath: "main.tex" })!;
  main.dispatch({ changes: { from: main.state.doc.length, insert: "\n% first input" }, userEvent: "input.type" });
  const closing = first.close();
  // The save intent is durable but its reply is still in flight. Current state
  // can advance; an old receipt cannot label this new version saved.
  await vi.waitFor(async () => expect((await storage.checkpoints.list(manuscriptId)).find(row => row.checkpoint.relativePath === "main.tex")?.checkpoint.saveIntent).toBeTruthy());
  main.resolveAll("keep");
  main.dispatch({ changes: { from: main.state.doc.length, insert: "\n% input during close" }, userEvent: "input.type" });
  expect(await closing).toBe(true);
  const snapshot = main.read();
  expect(first.checkpoints.isSaved(main.identity)).toBe(true);
  expect((await storage.files.readFile(manuscriptId, "main.tex")).content).toBe(snapshot.content);
  first.disconnect(); storage.fault = "none";
  expect((await open(storage)).files.get(main.identity)?.read()).toEqual(snapshot);
});
