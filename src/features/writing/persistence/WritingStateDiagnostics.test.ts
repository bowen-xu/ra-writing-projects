import { createHash } from "node:crypto";
import { undo, redo } from "@codemirror/commands";
import { afterEach, expect, it, vi } from "vitest";
import { parseManuscriptPath, type WritingCheckpointRecord } from "@research-assistant/writing";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import { WritingFileSaveQueue } from "./WritingFileSaveQueue";
import { clearWritingRecoveryDraft } from "./clearWritingRecoveryDraft";
import { WritingStateDiagnostics, type WritingDiagnosticEvent } from "./WritingStateDiagnostics";

const identity = { manuscriptId: "test-manuscript", relativePath: "main.tex" };
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const disk = (content: string) => ({ content, relativePath: parseManuscriptPath(identity.relativePath), sha256: hash(content) });
function setup(sink?: (event: WritingDiagnosticEvent) => void | Promise<void>, storage = new Map<string, WritingCheckpointRecord>()) {
  const events: WritingDiagnosticEvent[] = [];
  const diagnostics = new WritingStateDiagnostics(sink ?? (event => { events.push(event); }), async text => hash(text));
  const files = new WritingFileSessions(diagnostics), gateway = createMemoryWritingCheckpointGateway(storage);
  const persistence = new WritingCheckpointPersistence(files, gateway, vi.fn(), async text => hash(text));
  const disconnect = persistence.connect();
  return { events, diagnostics, files, gateway, persistence, disconnect, storage };
}
afterEach(() => vi.useRealTimers());

it("records immutable D/B transitions for Agent, Keep and unified history without plaintext", async () => {
  const host = setup(), session = host.files.open(identity, "old 摘要😀", hash("old 摘要😀"));
  session.applyAgent("actual-agent-operation", 0, "new 摘要😀");
  session.resolveAll("keep");
  undo({ state: session.state, dispatch: transaction => session.accept([transaction]) });
  redo({ state: session.state, dispatch: transaction => session.accept([transaction]) });
  await host.persistence.flushAll();
  await host.diagnostics.drain();
  const transitions = host.events.filter(event => event.phase === "install").sort((a, b) => a.sequence - b.sequence);
  expect(transitions.map(event => event.source)).toEqual(["disk-open", "agent", "review", "undo", "redo"]);
  expect(transitions[1]).toMatchObject({ operationId: "actual-agent-operation", before: { version: 0, contentSha256: hash("old 摘要😀") },
    after: { version: 1, contentSha256: hash("new 摘要😀"), baselineSha256: hash("old 摘要😀") } });
  expect(transitions[2]).toMatchObject({ after: { version: 2, contentSha256: hash("new 摘要😀"), baselineSha256: hash("new 摘要😀") } });
  expect(transitions[3]).toMatchObject({ after: { version: 3, baselineSha256: hash("old 摘要😀") } });
  expect(JSON.stringify(host.events)).not.toContain("摘要");
  host.disconnect();
});

it("correlates actual save intent and file ACK while preserving newer D/B", async () => {
  vi.useFakeTimers();
  const host = setup(), session = await host.persistence.open(identity.manuscriptId, disk("old"));
  session.applyAgent("agent", 0, "new");
  const fileGateway = { readFile: vi.fn(async () => disk("old")), saveFile: vi.fn(async (request: { content: string }) => disk(request.content)) };
  const queue = new WritingFileSaveQueue(host.files, host.persistence, fileGateway, vi.fn());
  const disconnectQueue = queue.connect();
  // Stop after the first reply to inspect its old version without preventing that write.
  let pause: Promise<() => void> | undefined;
  fileGateway.saveFile.mockImplementationOnce(async () => {
    session.resolveAll("keep");
    session.dispatch({ changes: { from: 3, insert: " latest" }, userEvent: "input.type" });
    pause = queue.pause();
    return disk("new");
  });
  await queue.save(identity);
  const release = await pause!;
  await host.diagnostics.drain();
  const formal = host.events.filter(event => event.phase === "formal-save");
  expect(formal.map(event => event.status)).toEqual(["started", "completed"]);
  expect(formal[0]).toMatchObject({ before: { version: 1 }, savedVersion: null, expectedSha256: hash("old"), targetSha256: hash("new") });
  const completed = host.events.find(event => event.source === "save-complete" && event.status === "completed");
  expect(completed).toMatchObject({ operationId: formal[0]!.operationId, savedVersion: 1,
    after: { version: 3, contentSha256: hash("new latest"), baselineSha256: hash("new latest") } });
  expect([...host.storage.values()][0]!.checkpoint).toMatchObject({ savedVersion: 1, version: 3, content: "new latest" });
  release(); await queue.save(identity);
  expect([...host.storage.values()][0]!.checkpoint).toMatchObject({ savedVersion: 3, version: 3, content: "new latest" });
  disconnectQueue(); host.disconnect();
});

it.each(["old", "new", "external"])("records startup reconciliation against actual disk: %s", async actual => {
  const first = setup(), session = await first.persistence.open(identity.manuscriptId, disk("old"));
  session.applyAgent("agent", 0, "new"); session.resolveAll("keep");
  const intent = await first.persistence.beginSave(session.read(), hash("old"));
  const second = setup(undefined, first.storage);
  if (actual === "external") await expect(second.persistence.open(identity.manuscriptId, disk(actual))).rejects.toThrow("外部");
  else await second.persistence.open(identity.manuscriptId, disk(actual));
  await second.diagnostics.drain();
  expect(second.events).toContainEqual(expect.objectContaining({ source: "checkpoint-restore", phase: "install" }));
  expect(second.events).toContainEqual(expect.objectContaining({ phase: "recovery", operationId: intent.operationId,
    source: actual === "old" ? "intent-not-written" : actual === "new" ? "intent-written" : "disk-conflict",
    targetSha256: hash(actual), after: expect.objectContaining({ contentSha256: hash("new"), baselineSha256: hash("new") }) }));
  first.disconnect(); second.disconnect();
});

it("observes real draft cleanup success and failure without clearing review state or exposing exceptions", async () => {
  const host = setup(), session = await host.persistence.open(identity.manuscriptId, disk("old"));
  session.applyAgent("agent", 0, "new"); session.resolveAll("keep");
  await host.persistence.flushAll();
  const snapshot = session.read(), stored = JSON.stringify([...host.storage.values()]);
  const clear = vi.fn(async () => undefined);
  await clearWritingRecoveryDraft(host.files, identity, "save-complete", clear);
  const reason = new Error("private正文 credential");
  await expect(clearWritingRecoveryDraft(host.files, identity, "discard-recovery", async () => { throw reason; })).rejects.toBe(reason);
  await host.diagnostics.drain();
  expect(clear).toHaveBeenCalledOnce();
  expect(session.read()).toEqual(snapshot);
  expect(JSON.stringify([...host.storage.values()])).toBe(stored);
  expect(JSON.stringify(host.events)).not.toContain(reason.message);
  const events = host.events.filter(event => event.phase === "draft-clear");
  expect(events.map(event => event.status)).toEqual(["started", "completed", "started", "failed"]);
  expect(events[1]!.operationId).toBe(events[0]!.operationId);
  expect(events[3]!.operationId).toBe(events[2]!.operationId);
  host.disconnect();
});

it("never waits for or propagates a failed observer during actual file persistence", async () => {
  const host = setup(async () => { throw new Error("observer failure"); });
  const session = await host.persistence.open(identity.manuscriptId, disk("old"));
  session.applyAgent("agent", 0, "new");
  await host.persistence.flushAll(); await host.diagnostics.drain();
  expect([...host.storage.values()][0]!.checkpoint.content).toBe("new");
  const slow = setup(() => new Promise(() => undefined));
  const slowSession = await slow.persistence.open(identity.manuscriptId, disk("old"));
  slowSession.applyAgent("agent", 0, "new");
  await slow.persistence.flushAll();
  expect([...slow.storage.values()][0]!.checkpoint.content).toBe("new");
  host.disconnect(); slow.disconnect();
});

it("does no hashing when disabled and emits only whitelisted immutable fields", async () => {
  const hashFn = vi.fn(async text => hash(text)), sink = vi.fn();
  const disabled = new WritingStateDiagnostics(undefined, hashFn);
  disabled.record({ ...identity, phase: "install", source: "disk-open", status: "completed" });
  await disabled.drain(); expect(hashFn).not.toHaveBeenCalled();
  const enabled = new WritingStateDiagnostics(sink, hashFn);
  const snapshot = { ...identity, version: 1, content: "private text", reviewBaseline: "private baseline" };
  const input = { ...identity, phase: "install" as const, source: "input" as const, status: "completed" as const,
    after: snapshot, rawError: "private credential" };
  enabled.record(input); snapshot.version = 99; input.manuscriptId = "changed";
  await enabled.drain();
  expect(sink.mock.calls[0]![0]).toMatchObject({ manuscriptId: identity.manuscriptId, after: { version: 1 } });
  expect(JSON.stringify(sink.mock.calls)).not.toContain("private");
});

it("bounds diagnostic work and makes skipped observations visible in the next event", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const events: WritingDiagnosticEvent[] = [], hashFn = vi.fn(async text => hash(text));
  const diagnostics = new WritingStateDiagnostics(async event => { events.push(event); await wait; }, hashFn);
  const input = { ...identity, phase: "install" as const, source: "input" as const, status: "completed" as const,
    after: { ...identity, version: 1, content: "private body", reviewBaseline: "private body" } };
  for (let index = 0; index < 40; index += 1) diagnostics.record(input);
  release(); await diagnostics.drain();
  expect(events).toHaveLength(32); expect(hashFn).toHaveBeenCalledTimes(64);
  diagnostics.record(input); await diagnostics.drain();
  expect(events[32]).toMatchObject({ sequence: 41, skipped: 8 });
});

it("reports a failed checkpoint read without installing a file or logging its exception", async () => {
  const host = setup(), reason = new Error("private recovery read failure");
  vi.spyOn(host.gateway, "list").mockRejectedValue(reason);
  await expect(host.persistence.open(identity.manuscriptId, disk("old"))).rejects.toBe(reason);
  await host.diagnostics.drain();
  expect(host.files.all()).toEqual([]);
  expect(host.events).toHaveLength(1);
  expect(host.events[0]).toMatchObject({ phase: "recovery", source: "checkpoint-restore", status: "failed",
    before: null, after: null, targetSha256: hash("old") });
  expect(JSON.stringify(host.events)).not.toContain("private");
  host.disconnect();
});

it("does not turn failed checkpoint or file acknowledgements into successful diagnostic stages", async () => {
  vi.useFakeTimers();
  const host = setup(), session = await host.persistence.open(identity.manuscriptId, disk("old"));
  session.applyAgent("agent", 0, "new");
  await host.persistence.flushAll();
  const fileGateway = { readFile: vi.fn(async () => disk("old")), saveFile: vi.fn(async () => { throw new Error("private write failure"); }) };
  const begin = vi.spyOn(host.persistence, "beginSave");
  const queue = new WritingFileSaveQueue(host.files, host.persistence, fileGateway, vi.fn()), disconnect = queue.connect();
  await expect(queue.save(identity)).rejects.toThrow("private write failure");
  await host.diagnostics.drain();
  expect(host.events.filter(event => event.phase === "formal-save").map(event => event.status)).toEqual(["started", "failed"]);
  const save = vi.spyOn(host.gateway, "save").mockRejectedValue(new Error("private checkpoint failure"));
  const intent = await begin.mock.results[0]!.value;
  await expect(host.persistence.completeSave(identity, intent, hash("new"))).rejects.toThrow("private checkpoint failure");
  await host.diagnostics.drain();
  expect(host.events.filter(event => event.source === "save-complete").map(event => event.status)).toEqual(["started", "failed"]);
  expect(host.events).toContainEqual(expect.objectContaining({ phase: "checkpoint", status: "failed" }));
  expect(JSON.stringify(host.events)).not.toContain("private");
  save.mockRestore(); disconnect(); host.disconnect();
});
