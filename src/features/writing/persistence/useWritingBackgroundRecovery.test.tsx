/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseManuscriptPath, type WritingCheckpointRecord } from "@research-assistant/writing";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import { useWritingBackgroundRecovery } from "./useWritingBackgroundRecovery";

let root: Root, element: HTMLDivElement, dispose: () => void;
afterEach(async () => { await act(async () => root?.unmount()); dispose?.(); element?.remove(); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Options = Parameters<typeof useWritingBackgroundRecovery>[0];
async function setup(read?: Options["gateway"]["readFile"], ready = true) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const files = new WritingFileSessions(), records = new Map<string, WritingCheckpointRecord>();
  const adapter = createMemoryWritingCheckpointGateway(records);
  for (const manuscriptId of ["old", "new"]) await adapter.save({ expectedRevision: null, checkpoint: {
    schemaVersion: 1, manuscriptId, relativePath: "background.tex", version: 1, savedVersion: 0, savedSha256: hash("disk"),
    content: manuscriptId + " working", reviewBaseline: "disk", operations: [], saveIntent: null,
  } });
  const checkpoints = new WritingCheckpointPersistence(files, adapter, () => undefined, async text => hash(text));
  dispose = checkpoints.connect();
  const gateway = { readFile: vi.fn(read ?? (async (_ms: string, path: string) => ({ relativePath: parseManuscriptPath(path), content: "disk", sha256: hash("disk") }))) };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  let result!: ReturnType<typeof useWritingBackgroundRecovery>;
  function Host({ options }: { options: Options }) { result = useWritingBackgroundRecovery(options); return result.feedback; }
  const options: Options = { manuscriptId: "old", ready, gateway, checkpoints, onFileConflict: vi.fn() };
  const render = async (value = options) => { await act(async () => root.render(<Host options={value} />)); };
  await render();
  return { files, gateway, options, render, result: () => result };
}

it("retains read failures as a send/apply barrier until explicit retry restores the original file state", async () => {
  const f = await setup(vi.fn().mockRejectedValueOnce(new Error("disk unavailable"))
    .mockResolvedValue({ relativePath: parseManuscriptPath("background.tex"), content: "disk", sha256: hash("disk") }));
  expect(f.result().ready).toBe(false); expect(f.result().pending).toBe(true);
  expect(element.textContent).toContain("重新读取文件检查点");
  await f.render({ ...f.options, ready: false }); await f.render();
  expect(f.gateway.readFile).toHaveBeenCalledOnce();
  await act(async () => element.querySelector<HTMLButtonElement>("button")!.click());
  expect(f.result().ready).toBe(true);
  expect(f.files.all()[0]!.read()).toMatchObject({ content: "old working", reviewBaseline: "disk" });
  expect(f.files.all()[0]!.hasBeenOpened).toBe(false);
});
it("waits for the manuscript host and does not reload recovered state around later exclusive operations", async () => {
  const f = await setup(undefined, false);
  expect(f.result().ready).toBe(false); expect(f.gateway.readFile).not.toHaveBeenCalled();
  await f.render({ ...f.options, ready: true });
  const state = f.files.all()[0]!.state;
  await f.render({ ...f.options, ready: false }); await f.render({ ...f.options, ready: true });
  expect(f.result().ready).toBe(true); expect(f.gateway.readFile).toHaveBeenCalledOnce();
  expect(f.files.all()[0]!.state).toBe(state);
});
it("ignores old manuscript replies while restoring the next manuscript with its own checkpoint", async () => {
  let finish!: (value: { relativePath: ReturnType<typeof parseManuscriptPath>; content: string; sha256: string }) => void;
  const f = await setup(async (ms, path) => ms === "old" ? new Promise(resolve => { finish = resolve; })
    : { relativePath: parseManuscriptPath(path), content: "disk", sha256: hash("disk") });
  expect(f.result().pending).toBe(true);
  await f.render({ ...f.options, manuscriptId: "new" });
  expect(f.result().ready).toBe(true);
  await act(async () => finish({ relativePath: parseManuscriptPath("background.tex"), content: "disk", sha256: hash("disk") }));
  expect(f.files.all().map(file => file.identity.manuscriptId)).toEqual(["new"]);
  expect(f.files.all()[0]!.read().content).toBe("new working");
});
it("keeps a live restoration query for an older published owner through a new gateway", async () => {
  const f = await setup(); const query = f.result().hasPending;
  expect(query()).toBe(false);
  let finish!: (value: Awaited<ReturnType<Options["gateway"]["readFile"]>>) => void;
  const gateway = {readFile: vi.fn(() => new Promise<Awaited<ReturnType<Options["gateway"]["readFile"]>>>(resolve => {finish = resolve;}))};
  await f.render({...f.options, manuscriptId: "new", gateway});
  expect(query()).toBe(true);
  await act(async () => finish({relativePath: parseManuscriptPath("background.tex"), content: "disk", sha256: hash("disk")}));
  expect(query()).toBe(false); expect(f.result().ready).toBe(true);
});
