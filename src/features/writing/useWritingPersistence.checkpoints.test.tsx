/** @vitest-environment happy-dom */
import { createHash } from "node:crypto";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseManuscriptPath, type ManuscriptFileContent, type WritingCheckpointRecord } from "@research-assistant/writing";
import { createMemoryWritingCheckpointGateway } from "./gateway/writingCheckpointGateway";
import type { WritingGateway } from "./gateway/writingGateway";
import { WritingFileSessions } from "./editor/writingFileSessions";
import { WritingFileSaveQueue } from "./persistence/WritingFileSaveQueue";
import { WritingCheckpointPersistence } from "./persistence/WritingCheckpointPersistence";
import { useWritingPersistence, type WritingPersistenceControl } from "./useWritingPersistence";
import type { SaveState } from "./workspaceState";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { manuscriptId: "manuscript", relativePath: parseManuscriptPath("main.tex") };
function hash(content: string) { return createHash("sha256").update(content).digest("hex"); }
afterEach(() => vi.useRealTimers());

async function mount(saveFile: WritingGateway["saveFile"], readFile = vi.fn(async () => ({ ...identity, content: "new", sha256: hash("new") })), withFileSaves = false) {
  const storage = new Map<string, WritingCheckpointRecord>(), fileSessions = new WritingFileSessions();
  const checkpoints = new WritingCheckpointPersistence(fileSessions, createMemoryWritingCheckpointGateway(storage), vi.fn(), async (value) => hash(value));
  const disconnect = checkpoints.connect();
  const session = await checkpoints.open(identity.manuscriptId, { ...identity, content: "old", sha256: hash("old") });
  const gateway = { saveFile, readFile, clearRecoveryDraft: vi.fn().mockResolvedValue(undefined), listFiles: vi.fn().mockResolvedValue([]),
    saveRecoveryDraft: vi.fn().mockResolvedValue(undefined), saveSession: vi.fn().mockResolvedValue(undefined) } as unknown as WritingGateway;
  const conflict = vi.fn(), error = vi.fn();
  const fileSaves = withFileSaves ? new WritingFileSaveQueue(fileSessions, checkpoints, gateway, error) : undefined;
  const disconnectSaves = fileSaves?.connect();
  const root = createRoot(document.createElement("div"));
  let control!: WritingPersistenceControl;
  function Host() {
    const [saveState, setSaveState] = useState<SaveState>("dirty"), [contentHash, setContentHash] = useState<string | undefined>(hash("old"));
    control = useWritingPersistence({ activeManuscriptId: identity.manuscriptId, activePath: identity.relativePath,
      // This deliberately stale projection must never supply the save body.
      content: "old", contentHash, saveState, setSaveState, setContentHash, fileSessions, checkpoints, ...(fileSaves ? { fileSaves } : {}), gateway,
      cursorOffsets: {}, layoutState: {}, openPaths: [identity.relativePath], onFileConflict: conflict, setError: error, setFiles: vi.fn() });
    return null;
  }
  await act(async () => root.render(<Host />));
  return { session, storage, gateway, conflict, error, checkpoints, fileSessions, fileSaves, control: () => control(), persistence: () => control,
    dispose: async () => { await act(async () => root.unmount()); disconnectSaves?.(); disconnect(); } };
}

it.each([false, true])("persists the CodeMirror body and baseline while a native save is in flight (shared queue: %s)", async (withFileSaves) => {
  let finish!: (value: ManuscriptFileContent) => void, started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const saveFile = vi.fn<WritingGateway["saveFile"]>().mockImplementationOnce(() => {
    started(); return new Promise((resolve) => { finish = resolve; });
  }).mockImplementation(async (request) => ({ relativePath: request.relativePath, content: request.content, sha256: hash(request.content) }));
  const host = await mount(saveFile, undefined, withFileSaves);
  try {
    let saving!: Promise<boolean>;
    await act(async () => { host.session.applyAgent("operation", 0, "new"); saving = host.control(); await dispatched; });
    expect([...host.storage.values()][0]?.checkpoint.saveIntent).toMatchObject({ targetSha256: hash("new"), version: 1 });
    await act(async () => {
      host.session.resolveAll("keep");
      host.session.dispatch({ changes: { from: 3, insert: " manual" }, userEvent: "input.type" });
      finish({ ...identity, content: "new", sha256: hash("new") });
      expect(await saving).toBe(true);
    });
    expect(saveFile.mock.calls.map(([request]) => request.content)).toEqual(["new", "new manual"]);
    expect(saveFile.mock.calls[1]?.[0].expectedSha256).toBe(hash("new"));
    expect([...host.storage.values()][0]?.checkpoint).toMatchObject({ content: "new manual", reviewBaseline: "new manual",
      savedSha256: hash("new manual"), savedVersion: 3, version: 3, saveIntent: null });
    expect(host.gateway.saveRecoveryDraft).not.toHaveBeenCalled();
  } finally { await host.dispose(); }
});

it("reconciles an uncertain file write before retrying, instead of reusing the old expected hash", async () => {
  const saveFile = vi.fn<WritingGateway["saveFile"]>().mockRejectedValueOnce(new Error("file acknowledgement lost"))
    .mockImplementation(async (request) => ({ relativePath: request.relativePath, content: request.content, sha256: hash(request.content) }));
  const host = await mount(saveFile);
  try {
    await act(async () => { host.session.applyAgent("operation", 0, "new"); expect(await host.control()).toBe(false); });
    expect([...host.storage.values()][0]?.checkpoint.saveIntent).not.toBeNull();
    await act(async () => { expect(await host.control()).toBe(true); });
    expect(host.gateway.readFile).toHaveBeenCalledExactlyOnceWith(identity.manuscriptId, identity.relativePath);
    expect(saveFile.mock.calls[1]?.[0].expectedSha256).toBe(hash("new"));
    expect([...host.storage.values()][0]?.checkpoint).toMatchObject({ content: "new", reviewBaseline: "old", saveIntent: null });
    expect(host.session.pending).toBe(true);
  } finally { await host.dispose(); }
});

it("routes a genuinely changed disk version to comparison while keeping the working D/B", async () => {
  const saveFile = vi.fn<WritingGateway["saveFile"]>().mockRejectedValue(new Error("write failed"));
  const readFile = vi.fn(async () => ({ ...identity, content: "external", sha256: hash("external") }));
  const host = await mount(saveFile, readFile);
  try {
    await act(async () => { host.session.applyAgent("operation", 0, "new"); expect(await host.control()).toBe(false); });
    await act(async () => { expect(await host.control()).toBe(false); });
    expect(saveFile).toHaveBeenCalledOnce();
    expect(host.conflict).toHaveBeenCalledWith({ ...identity, bufferedContent: "new" });
    expect(host.session.read()).toMatchObject({ content: "new", reviewBaseline: "old" });
  } finally { await host.dispose(); }
});

it("uses the same formal queue for the active hook and a headless file under one pause lease", async () => {
  const saveFile = vi.fn<WritingGateway["saveFile"]>().mockImplementation(async (request) => ({ relativePath: request.relativePath,
    content: request.content, sha256: hash(request.content) }));
  const host = await mount(saveFile, undefined, true);
  try {
    const other = await host.checkpoints.open(identity.manuscriptId, { relativePath: parseManuscriptPath("other.tex"), content: "other old", sha256: hash("other old") });
    let release!: Awaited<ReturnType<WritingPersistenceControl["pause"]>>;
    await act(async () => { release = await host.persistence().pause(); });
    await act(async () => { host.session.applyAgent("active", 0, "new"); other.applyAgent("headless", 0, "other new"); });
    await host.checkpoints.flushAll();
    expect(saveFile).not.toHaveBeenCalled();
    expect(release.readSnapshot()?.content).toBe("new");
    await act(async () => { release(); await host.fileSaves!.flushAll(); });
    expect(saveFile.mock.calls.map(([request]) => request.relativePath).sort()).toEqual(["main.tex", "other.tex"]);
    expect(host.checkpoints.isSaved(host.session.identity)).toBe(true);
    expect(host.checkpoints.isSaved(other.identity)).toBe(true);
  } finally { await host.dispose(); }
});
