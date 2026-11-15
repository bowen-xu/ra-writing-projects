/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useWritingFileLoader } from "./useWritingFileLoader";
import { createExclusiveWritingGateway } from "./gateway/exclusiveWritingGateway";
import type { WritingGateway } from "./gateway/writingGateway";
import { WritingFileSessions } from "./editor/writingFileSessions";
import { WritingCheckpointPersistence } from "./persistence/WritingCheckpointPersistence";
import { createMemoryWritingCheckpointGateway } from "./gateway/writingCheckpointGateway";
import { parseManuscriptPath } from "@research-assistant/writing";

it("does not install a late file read after exclusive ownership has been requested", async () => {
  const root = createRoot(document.createElement("div"));
  let finish!: (value: unknown) => void;
  const readFile = vi.fn(() => new Promise(resolve => {finish = resolve;}));
  const access = createExclusiveWritingGateway({readFile} as unknown as WritingGateway);
  const setActivePath = vi.fn(), setContent = vi.fn();
  let open!: ReturnType<typeof useWritingFileLoader>;
  function Host() {
    open = useWritingFileLoader({manuscriptId: "m", gateway: access.gateway, canOpen: () => !access.isExclusive(),
      setActivePath, setContent, setContentHash: vi.fn(), setOpenPaths: vi.fn(), setSaveState: vi.fn(),
      setError: vi.fn(), setPendingRecovery: vi.fn()});
    return null;
  }
  let release: (() => void) | undefined;
  try {
    await act(async () => root.render(<Host/>));
    const pending = open("other.tex");
    const exclusive = access.acquire();
    await act(async () => {
      await Promise.resolve();
      finish({relativePath: "other.tex", content: "old read", sha256: "hash"});
      release = await exclusive;
      expect(await pending).toBeUndefined();
    });
    expect(setActivePath).not.toHaveBeenCalled(); expect(setContent).not.toHaveBeenCalled();
    expect(await open("new.tex")).toBeUndefined();
    expect(readFile).toHaveBeenCalledTimes(1);
    if (!release) throw new Error("Exclusive lease was not acquired");
    release();
    readFile.mockResolvedValue({relativePath: "new.tex", content: "new read", sha256: "hash"});
    await act(async () => {await open("new.tex");});
    expect(setActivePath).toHaveBeenCalledWith("new.tex");
    expect(setContent).toHaveBeenCalledWith("new read");
  } finally {release?.(); await act(async () => root.unmount());}
});

it("reopens the file-owned working text instead of replacing it with a disk read", async () => {
  const files = new WritingFileSessions();
  const session = files.open({ manuscriptId: "m", relativePath: "main.tex" }, "disk");
  session.applyAgent("operation", 0, "working");
  session.resolveAll("keep");
  const setContent = vi.fn(), setSaveState = vi.fn();
  const gateway = { readFile: vi.fn(async () => ({ relativePath: "main.tex", content: "disk", sha256: "hash" })) } as unknown as WritingGateway;
  const root = createRoot(document.createElement("div"));
  let open!: ReturnType<typeof useWritingFileLoader>;
  function Host() {
    open = useWritingFileLoader({ manuscriptId: "m", gateway, fileSessions: files,
      setContent, setSaveState, setActivePath: vi.fn(), setContentHash: vi.fn(),
      setOpenPaths: vi.fn(), setError: vi.fn(), setPendingRecovery: vi.fn() });
    return null;
  }
  try {
    await act(async () => root.render(<Host />));
    await act(async () => { await open("main.tex"); });
    expect(setContent).toHaveBeenCalledWith("working");
    expect(setSaveState).toHaveBeenCalledWith("dirty");
    expect(session.read()).toMatchObject({ content: "working", reviewBaseline: "working", version: 2 });
  } finally { await act(async () => root.unmount()); }
});

it("loads durable D/B through the production file loader before publishing editor content", async () => {
  const files = new WritingFileSessions(), adapter = createMemoryWritingCheckpointGateway(new Map());
  await adapter.save({ expectedRevision: null, checkpoint: { schemaVersion: 1, manuscriptId: "m", relativePath: parseManuscriptPath("main.tex"),
    version: 2, content: "confirmed draft", reviewBaseline: "confirmed draft", savedSha256: "a".repeat(64), savedVersion: 0, operations: [], saveIntent: null } });
  const checkpoints = new WritingCheckpointPersistence(files, adapter, vi.fn());
  const disconnect = checkpoints.connect();
  const root = createRoot(document.createElement("div")), setContent = vi.fn(), setSaveState = vi.fn();
  const gateway = { readFile: vi.fn(async () => ({ relativePath: parseManuscriptPath("main.tex"), content: "disk", sha256: "a".repeat(64) })) } as unknown as WritingGateway;
  let open!: ReturnType<typeof useWritingFileLoader>;
  function Host() {
    open = useWritingFileLoader({ manuscriptId: "m", gateway, fileSessions: files, checkpoints,
      setContent, setSaveState, setActivePath: vi.fn(), setContentHash: vi.fn(), setOpenPaths: vi.fn(), setError: vi.fn(), setPendingRecovery: vi.fn() });
    return null;
  }
  try {
    await act(async () => root.render(<Host />));
    await act(async () => { await open("main.tex"); });
    expect(setContent).toHaveBeenCalledExactlyOnceWith("confirmed draft");
    expect(setSaveState).toHaveBeenCalledExactlyOnceWith("dirty");
    expect(files.get({ manuscriptId: "m", relativePath: "main.tex" })?.pending).toBe(false);
  } finally { await act(async () => root.unmount()); disconnect(); }
});
