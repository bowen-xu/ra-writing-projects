import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseManuscriptPath, type WritingCheckpointRecord } from "@research-assistant/writing";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";

const identity = { manuscriptId: "manuscript", relativePath: "main.tex" };
function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function disk(content: string) { return { relativePath: parseManuscriptPath(identity.relativePath), content, sha256: hash(content) }; }
function setup(storage = new Map<string, WritingCheckpointRecord>()) {
  const files = new WritingFileSessions(), errors = vi.fn();
  const adapter = createMemoryWritingCheckpointGateway(storage);
  const gateway = { list: vi.fn(adapter.list), save: vi.fn(adapter.save) };
  const owner = new WritingCheckpointPersistence(files, gateway, errors, async (content) => hash(content));
  const disconnect = owner.connect();
  return { files, errors, gateway, owner, disconnect, storage };
}
function checkpoint(host: ReturnType<typeof setup>) { return [...host.storage.values()][0]!.checkpoint; }
afterEach(() => vi.useRealTimers());

it("captures current checkpoint CAS for Undo after typing during persistence acknowledgement", async () => {
  const host = setup(), session = await host.owner.open(identity.manuscriptId, disk("old"));
  await host.owner.flushAll();
  session.applyAgent("operation", 0, "new");
  const save = host.gateway.save.getMockImplementation()!;
  host.gateway.save.mockImplementationOnce(async write => {
    const result = await save(write);
    session.dispatch({ changes: { from: 3, insert: " latest" }, userEvent: "input.type" });
    return result;
  });
  const versions = await host.owner.captureUndoCheckpointVersions(identity.manuscriptId);
  const record = [...host.storage.values()][0]!;
  expect(record.checkpoint.content).toBe("new latest");
  expect(versions).toEqual([{ path: identity.relativePath, revision: record.revision, stateVersion: session.read().version }]);
  expect(record.checkpoint.version).toBe(session.read().version);
  host.disconnect();
});
it("does not provide Undo checkpoint evidence while a formal save intent is unresolved", async () => {
  const host = setup(), session = await host.owner.open(identity.manuscriptId, disk("old"));
  session.applyAgent("operation", 0, "new");
  await host.owner.beginSave(session.read(), hash("old"));
  await expect(host.owner.captureUndoCheckpointVersions(identity.manuscriptId)).rejects.toThrow("检查点");
  expect(checkpoint(host).saveIntent).not.toBeNull();
  host.disconnect();
});

it("recovers baseline-only Keep without reading a conversation or replaying a document edit", async () => {
  const first = setup();
  const session = await first.owner.open(identity.manuscriptId, disk("old\r\n摘要😀"));
  session.applyAgent("operation", 0, "new\r\n摘要😀");
  session.resolveAll("keep");
  await first.owner.flushAll();
  expect(checkpoint(first)).toMatchObject({ content: "new\r\n摘要😀", reviewBaseline: "new\r\n摘要😀", version: 2 });
  first.disconnect();
  const second = setup(first.storage);
  const restored = await second.owner.open(identity.manuscriptId, disk("old\r\n摘要😀"));
  expect(restored.read()).toMatchObject({ content: "new\r\n摘要😀", reviewBaseline: "new\r\n摘要😀", version: 2 });
  expect(restored.pending).toBe(false);
  expect(restored.hasBeenOpened).toBe(false);
  expect(restored.state.doc.toString()).toBe("new\r\n摘要😀");
  second.disconnect();
});

it("records intent before file I/O and acknowledges an old save with the latest D/B", async () => {
  const host = setup(), session = await host.owner.open(identity.manuscriptId, disk("old"));
  session.applyAgent("operation", 0, "new");
  const snapshot = session.read();
  const intent = await host.owner.beginSave(snapshot, hash("old"));
  expect(checkpoint(host).saveIntent).toEqual(intent);
  session.resolveAll("keep");
  session.dispatch({ changes: { from: 3, insert: " manually" }, userEvent: "input.type" });
  await host.owner.completeSave(identity, intent, hash("new"));
  expect(checkpoint(host)).toMatchObject({ content: "new manually", reviewBaseline: "new manually", version: 3,
    savedSha256: hash("new"), savedVersion: snapshot.version, saveIntent: null });
  expect(session.savedSha256).toBe(hash("new"));
  const second = setup(host.storage);
  expect((await second.owner.open(identity.manuscriptId, disk("new"))).read()).toMatchObject({
    content: "new manually", reviewBaseline: "new manually", version: 3 });
  host.disconnect(); second.disconnect();
});

it.each(["old", "new"])("reconciles an interrupted save against actual disk content: %s", async (actual) => {
  const first = setup(), session = await first.owner.open(identity.manuscriptId, disk("old"));
  session.applyAgent("operation", 0, "new");
  session.resolveAll("keep");
  const intent = await first.owner.beginSave(session.read(), hash("old"));
  expect(checkpoint(first).saveIntent).toEqual(intent);
  // A new volatile owner stands in for a new process. Durable storage and the
  // formal file are independent; no disconnect/ack is used to manufacture recovery.
  const second = setup(first.storage);
  const restored = await second.owner.open(identity.manuscriptId, disk(actual));
  expect(restored.read()).toMatchObject({ content: "new", reviewBaseline: "new" });
  expect(restored.pending).toBe(false);
  expect(checkpoint(second)).toMatchObject({ saveIntent: null, savedSha256: hash(actual),
    savedVersion: actual === "new" ? intent.version : 0 });
  second.disconnect();
});

it("retries the exact uncertain checkpoint before persisting a later Keep", async () => {
  const host = setup(), session = await host.owner.open(identity.manuscriptId, disk("old"));
  const save = host.gateway.save.getMockImplementation()!;
  host.gateway.save.mockImplementationOnce(async (write) => { await save(write); throw new Error("ack lost"); });
  session.applyAgent("operation", 0, "new");
  await host.owner.flush(identity);
  // Agent persistence errors belong to the operation owner; the retry must
  // preserve its exact write without also creating a user notification.
  expect(host.errors).not.toHaveBeenCalled();
  expect(host.gateway.save.mock.calls[0]).toEqual(host.gateway.save.mock.calls[1]);
  session.resolveAll("keep");
  await host.owner.flush(identity);
  expect(checkpoint(host)).toMatchObject({ content: "new", reviewBaseline: "new", version: 2 });
  host.disconnect();
});

it("preserves conflicted D/B until the user explicitly reloads the external file", async () => {
  const first = setup(), session = await first.owner.open(identity.manuscriptId, disk("old"));
  session.applyAgent("operation", 0, "new");
  await first.owner.flush(identity);
  const second = setup(first.storage);
  await expect(second.owner.open(identity.manuscriptId, disk("external"))).rejects.toMatchObject({ code: "file_conflict" });
  const buffered = second.files.get(identity)!;
  expect(buffered.read()).toMatchObject({ content: "new", reviewBaseline: "old" });
  await second.owner.flush(identity);
  expect(checkpoint(second)).toMatchObject({ content: "new", reviewBaseline: "old", savedSha256: hash("old") });
  buffered.reloadDisk("external", hash("external"));
  await second.owner.flush(identity);
  expect(checkpoint(second)).toMatchObject({ content: "external", reviewBaseline: "external", savedSha256: hash("external") });
  second.disconnect();
});

it("checkpoints only after three idle seconds and restarts the deadline on every edit", async () => {
  vi.useFakeTimers();
  const host = setup(), session = await host.owner.open(identity.manuscriptId, disk("old"));
  session.dispatch({ changes: { from: 0, insert: "a" }, userEvent: "input.type" });
  await vi.advanceTimersByTimeAsync(2999);
  expect(host.storage.size).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(checkpoint(host).content).toBe("aold");
  host.gateway.save.mockClear();
  for (let index = 0; index < 5; index += 1) {
    session.dispatch({ changes: { from: 0, insert: "b" }, userEvent: "input.type" });
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(host.gateway.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1999);
  expect(host.gateway.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(checkpoint(host)).toMatchObject({ content: "bbbbbaold", reviewBaseline: "bbbbbaold" });
  expect(host.gateway.save).toHaveBeenCalledOnce();
  host.disconnect();
});

it("drains input arriving while a checkpoint acknowledgement is delayed before completing a close flush", async () => {
  const host = setup(), session = await host.owner.open(identity.manuscriptId, disk("old"));
  const save = host.gateway.save.getMockImplementation()!;
  let finish!: () => void, started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  host.gateway.save.mockImplementationOnce(async (write) => { started(); await new Promise<void>((resolve) => { finish = resolve; }); return save(write); });
  session.dispatch({ changes: { from: 0, insert: "a" }, userEvent: "input.type" });
  const flushing = host.owner.flushAll();
  await dispatched;
  session.dispatch({ changes: { from: 0, insert: "b" }, userEvent: "input.type" });
  finish(); await flushing;
  expect(checkpoint(host)).toMatchObject({ content: "baold", reviewBaseline: "baold", version: 2 });
  expect(host.gateway.save).toHaveBeenCalledTimes(2);
  host.disconnect();
});
