import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath, type WritingCheckpointRecord } from "@research-assistant/writing";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";

const manuscriptId = "manuscript";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const disk = (path: string, text = "old") => ({ relativePath: parseManuscriptPath(path), content: text, sha256: hash(text) });
async function seed(withSaveIntent = false) {
  const records = new Map<string, WritingCheckpointRecord>(), files = new WritingFileSessions();
  const owner = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(records), () => undefined, async text => hash(text));
  const disconnect = owner.connect();
  const session = await owner.open(manuscriptId, disk("sections/background.tex"));
  const current = session.applicationPort.read()!;
  await owner.applyEditorAgent(session.identity, { operationId: "operation", conversationId: "conversation", requestId: "request" },
    { operationId: "operation", expected: current, text: "new\r\n摘要😀" });
  session.resolveAll("keep");
  if (withSaveIntent) await owner.beginSave(session.read(), hash("old"));
  await owner.flushAll(); disconnect();
  const restoredFiles = new WritingFileSessions(), adapter = createMemoryWritingCheckpointGateway(records);
  const gateway = { list: vi.fn(adapter.list), save: vi.fn(adapter.save) };
  const restored = new WritingCheckpointPersistence(restoredFiles, gateway, () => undefined, async text => hash(text));
  const dispose = restored.connect();
  return { records, files: restoredFiles, owner: restored, gateway, dispose, original: session.readEditorReceipt()! };
}

it("restores a kept background document and its original receipt without replacing existing editor state", async () => {
  const f = await seed(), active = await f.owner.open(manuscriptId, disk("main.tex", "active"));
  active.dispatch({ changes: { from: 6, insert: " input" }, selection: { anchor: 5 } });
  const state = active.state, read = vi.fn(async (path: string) => disk(path));
  await f.owner.restoreBackground(manuscriptId, read, () => true, vi.fn());
  const file = f.files.get({ manuscriptId, relativePath: "sections/background.tex" })!;
  expect(file.read()).toMatchObject({ content: "new\r\n摘要😀", reviewBaseline: "new\r\n摘要😀" });
  expect(file.pending).toBe(false); expect(file.hasBeenOpened).toBe(false);
  expect(file.applicationPort.readReceipt("operation")?.snapshot).toMatchObject({
    sessionId: f.original.sessionId, revision: f.original.revision, text: f.original.text });
  expect(active.state).toBe(state); expect(read.mock.calls).toEqual([["sections/background.tex"]]);
  f.dispose();
});
it("retries a reconciled background checkpoint with a lost acknowledgement before reporting readiness", async () => {
  const f = await seed(true), read = vi.fn(async (path: string) => disk(path, "new\r\n摘要😀"));
  const save = f.gateway.save.getMockImplementation()!;
  let unavailable = true;
  f.gateway.save.mockImplementation(async write => {
    const record = await save(write);
    if (unavailable) throw new Error("checkpoint reply lost");
    return record;
  });
  await expect(f.owner.restoreBackground(manuscriptId, read, () => true, vi.fn())).rejects.toThrow("reply lost");
  const session = f.files.all()[0]!, state = session.state, write = f.gateway.save.mock.calls[0]![0];
  await expect(f.owner.restoreBackground(manuscriptId, read, () => true, vi.fn())).rejects.toThrow("reply lost");
  expect(f.gateway.save.mock.calls[1]![0]).toEqual(write);
  unavailable = false;
  await f.owner.restoreBackground(manuscriptId, read, () => true, vi.fn());
  expect(read).toHaveBeenCalledOnce(); expect(session.state).toBe(state);
  expect(f.owner.isSaved(session.identity)).toBe(true);
  expect([...f.records.values()][0]!.checkpoint.saveIntent).toBeNull();
  f.dispose();
});
it("preserves externally conflicted background content and retries its actual disk check", async () => {
  const f = await seed(), conflict = vi.fn();
  const read = vi.fn(async (path: string) => disk(path, "external"));
  await expect(f.owner.restoreBackground(manuscriptId, read, () => true, conflict)).rejects.toMatchObject({ code: "file_conflict" });
  expect(conflict).toHaveBeenCalledWith(expect.objectContaining({ relativePath: "sections/background.tex", content: "new\r\n摘要😀" }));
  const file = f.files.all()[0]!;
  await expect(f.owner.beginSave(file.read(), hash("old"))).rejects.toMatchObject({ code: "file_conflict" });
  expect(f.gateway.save).not.toHaveBeenCalled();
  read.mockImplementation(async path => disk(path));
  await f.owner.restoreBackground(manuscriptId, read, () => true, conflict);
  expect(read).toHaveBeenCalledTimes(2); expect(conflict).toHaveBeenCalledTimes(1);
  expect(file.read().content).toBe("new\r\n摘要😀");
  expect((await f.owner.beginSave(file.read(), hash("old"))).version).toBe(file.read().version);
  f.dispose();
});
it("ignores a late disk read after its manuscript owner stops being current", async () => {
  const f = await seed();
  let finish!: (value: ReturnType<typeof disk>) => void, current = true;
  const read = vi.fn(() => new Promise<ReturnType<typeof disk>>(resolve => { finish = resolve; }));
  const pending = f.owner.restoreBackground(manuscriptId, read, () => current, vi.fn());
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  current = false; finish(disk("sections/background.tex")); await pending;
  expect(f.files.all()).toEqual([]); expect(f.gateway.save).not.toHaveBeenCalled(); f.dispose();
});
it("rejects a mismatched disk response without creating a different file session", async () => {
  const f = await seed();
  await expect(f.owner.restoreBackground(manuscriptId, async () => disk("wrong.tex"), () => true, vi.fn())).rejects.toThrow("身份不匹配");
  expect(f.files.all()).toEqual([]); expect(f.gateway.save).not.toHaveBeenCalled(); f.dispose();
});
