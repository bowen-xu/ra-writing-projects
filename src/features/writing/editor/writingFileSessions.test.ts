import { redo, undo } from "@codemirror/commands";
import { getOriginalDoc } from "@codemirror/merge";
import { expect, it, vi } from "vitest";
import { WritingFileSessions } from "./writingFileSessions";
import { captureWritingEditor } from "./editorSession";

const identity = { manuscriptId: "manuscript", relativePath: "main.tex" };

it("captures latest source buffers for the whole manuscript without depending on the visible file or conversation", () => {
  const files = new WritingFileSessions(), first = files.open(identity, "old", "disk-a");
  first.applyAgent("agent-a", 0, "proposed");
  const second = files.open({ ...identity, relativePath: "second.tex" }, "second", "disk-b");
  second.dispatch({ changes: { from: 0, insert: "unsaved " }, userEvent: "input.type" });
  files.open({ ...identity, relativePath: "notes/test.ranote" }, "note", "note-hash");
  files.open({ ...identity, manuscriptId: "other" }, "other", "other-hash");
  files.open({ ...identity, relativePath: "loading.tex" }, "loading");
  expect(files.readBuffers(identity.manuscriptId)).toEqual([
    { path: "main.tex", expectedDiskSha256: "disk-a", sessionId: captureWritingEditor(first.state, "key").sessionId,
      revision: captureWritingEditor(first.state, "key").revision, text: "proposed" },
    { path: "second.tex", expectedDiskSha256: "disk-b", sessionId: captureWritingEditor(second.state, "key").sessionId,
      revision: captureWritingEditor(second.state, "key").revision, text: "unsaved second" },
  ]);
  first.resolveAll("keep"); first.recordSaved("saved-new");
  expect(files.readBuffers(identity.manuscriptId)[0]).toMatchObject({ text: "proposed", expectedDiskSha256: "saved-new" });
});

it("keeps file identities and histories separate while reopening the latest working text", () => {
  const files = new WritingFileSessions();
  const first = files.open(identity, "old");
  expect(first.applyAgent("operation-a", 0, "new")).toBe("applied");
  const second = files.open({ ...identity, relativePath: "second.tex" }, "second");
  second.dispatch({ changes: { from: 0, insert: "prefix " }, userEvent: "input.type" });
  expect(files.open(identity, "old disk text")).toBe(first);
  expect(first.read()).toMatchObject({ content: "new", reviewBaseline: "old", version: 1 });
  expect(files.open({ ...identity, manuscriptId: "other" }, "other")).not.toBe(first);
  expect(undo({ state: first.state, dispatch: (transaction) => first.accept([transaction]) })).toBe(true);
  expect(first.read()).toMatchObject({ content: "old", reviewBaseline: "old", version: 2 });
  expect(second.read()).toMatchObject({ content: "prefix second", reviewBaseline: "prefix second" });
});

it("keeps all Agent changes in one history item in an unopened file", () => {
  const session = new WritingFileSessions().open(identity, "old one\nunchanged\nold two");
  const current = "new one\nunchanged\nnew two";
  expect(session.applyAgent("batch", 0, current)).toBe("applied");
  expect(session.pending).toBe(true);
  const commandTarget = { get state() { return session.state; }, dispatch: (transaction: Parameters<typeof session.accept>[0][number]) => session.accept([transaction]) };
  expect(undo(commandTarget)).toBe(true);
  expect(session.read().content).toBe("old one\nunchanged\nold two");
  expect(redo(commandTarget)).toBe(true);
  expect(session.read().content).toBe(current);
});

it("increments versions for baseline-only Keep and restores it through history", () => {
  const files = new WritingFileSessions();
  const session = files.open(identity, "old");
  const initialRevision = files.getRevision();
  const listener = vi.fn();
  session.subscribe(listener);
  session.applyAgent("batch", 0, "new");
  session.resolveAll("keep");
  expect(session.read()).toMatchObject({ content: "new", reviewBaseline: "new", version: 2 });
  expect(listener).toHaveBeenCalledTimes(2);
  expect(files.getRevision()).toBe(initialRevision + 2);
  expect(undo({ state: session.state, dispatch: (transaction) => session.accept([transaction]) })).toBe(true);
  expect(getOriginalDoc(session.state).toString()).toBe("old");
  expect(session.read().version).toBe(3);
});

it("rejects stale Agent results and deduplicates delivery even after Keep and undo", () => {
  const session = new WritingFileSessions().open(identity, "old");
  const version = session.read().version;
  session.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" });
  expect(session.applyAgent("stale", version, "overwrite")).toBe("conflict");
  expect(session.read().content).toBe("manual old");
  expect(session.applyAgent("fresh", session.read().version, "manual new")).toBe("applied");
  session.resolveAll("keep");
  expect(session.applyAgent("fresh", 0, "manual new")).toBe("duplicate");
  expect(session.applyAgent("fresh", 0, "different payload")).toBe("conflict");
  expect(session.read()).toMatchObject({ content: "manual new", reviewBaseline: "manual new" });
});

it("retains pending baseline for a subsequent operation based on the latest text", () => {
  const session = new WritingFileSessions().open(identity, "original");
  session.applyAgent("chat-a", 0, "first proposal");
  const latest = session.read();
  expect(latest.content).toBe("first proposal");
  session.applyAgent("chat-b", latest.version, "second proposal");
  expect(session.read()).toMatchObject({ content: "second proposal", reviewBaseline: "original" });
  expect(undo({ state: session.state, dispatch: (transaction) => session.accept([transaction]) })).toBe(true);
  expect(session.read()).toMatchObject({ content: "first proposal", reviewBaseline: "original" });
});

it("does not count cursor transactions as document changes and rejects stale state transactions", () => {
  const session = new WritingFileSessions().open(identity, "old");
  const stale = session.state.update({ changes: { from: 0, insert: "stale" } });
  session.dispatch({ selection: { anchor: 2 } });
  expect(session.read().version).toBe(0);
  expect(() => session.accept([stale])).toThrow("Stale file transaction");
  expect(session.read().content).toBe("old");
});

it("does not pair a stale buffer with a new external disk version", () => {
  const files = new WritingFileSessions();
  const session = files.open(identity, "original disk", "disk-hash-a");
  session.applyAgent("agent", 0, "working");
  expect(() => files.open(identity, "external disk", "disk-hash-b")).toThrow("文件已被外部修改");
  expect(session.read()).toMatchObject({ content: "working", reviewBaseline: "original disk" });
  expect(files.open(identity, "original disk", "disk-hash-a")).toBe(session);
  session.recordSaved("saved-working");
  expect(files.open(identity, "working", "saved-working")).toBe(session);
  expect(session.pending).toBe(true);
  session.reloadDisk("external disk", "disk-hash-b");
  expect(session.read()).toMatchObject({ content: "external disk", reviewBaseline: "external disk" });
  expect(files.open(identity, "external disk", "disk-hash-b")).toBe(session);
});
