/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {parseManuscriptPath, type ManuscriptFile} from "@research-assistant/writing";
import {WritingFileSessions} from "./editor/writingFileSessions";
import type {WritingGateway} from "./gateway";
import {useWritingFileLoader} from "./useWritingFileLoader";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const stop of cleanup.splice(0)) await stop();});
async function fixture() {
  const files = new WritingFileSessions(), hash = "a".repeat(64);
  const retained = files.open({manuscriptId: "m", relativePath: "main.tex"}, "original", hash);
  const gateway = {readFile: vi.fn(async (_id: string, path: string) => ({relativePath: parseManuscriptPath(path), content: "original", sha256: hash}))};
  const publish = vi.fn(), conflicts = vi.fn();
  const metadata = [{manuscriptId: "m", relativePath: parseManuscriptPath("main.tex"), sha256: hash}] as ManuscriptFile[];
  let options = {openPaths: ["main.tex", "other.tex"], metadata};
  let open!: ReturnType<typeof useWritingFileLoader>;
  function Host() {
    open = useWritingFileLoader({manuscriptId: "m", gateway: gateway as unknown as WritingGateway, fileSessions: files,
      files: options.metadata, openPaths: options.openPaths, setActivePath: vi.fn(), setContent: publish, setContentHash: vi.fn(),
      setSaveState: vi.fn(), setOpenPaths: vi.fn(), setError: vi.fn(), setPendingRecovery: vi.fn(), onFileConflict: conflicts});
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Host/>)); cleanup.push(async () => {await act(async () => root.unmount());});
  return {retained, gateway, publish, conflicts, open: (path: string) => open(path),
    activate: (path: string, metadata: readonly ManuscriptFile[], paths: readonly string[]) => open(path, "m", () => true, {files: metadata, openPaths: paths}),
    update: async (next: typeof options) => {options = next; await act(async () => root.render(<Host/>));}, metadata};
}
it("reactivates a known open source without disk I/O and retains its pending Diff and undo state", async () => {
  const f = await fixture(); f.retained.applyAgent("edit", 0, "candidate");
  await act(async () => {await f.open("main.tex");});
  expect(f.gateway.readFile).not.toHaveBeenCalled(); expect(f.publish).toHaveBeenLastCalledWith("candidate");
  expect(f.retained.pending).toBe(true);
  expect(f.retained.resolveAll("undo")).toBe(true); expect(f.retained.read().content).toBe("original");
});
it("reads a changed file and preserves the existing conflict guard instead of installing over live edits", async () => {
  const f = await fixture(); f.retained.applyAgent("edit", 0, "local input");
  await f.update({openPaths: ["main.tex"], metadata: [{...f.metadata[0]!, sha256: "b".repeat(64)}]});
  f.gateway.readFile.mockResolvedValueOnce({relativePath: parseManuscriptPath("main.tex"), content: "external", sha256: "b".repeat(64)});
  await act(async () => {await f.open("main.tex");});
  expect(f.gateway.readFile).toHaveBeenCalledOnce(); expect(f.conflicts).toHaveBeenCalledOnce();
  expect(f.retained.read().content).toBe("local input"); expect(f.publish).not.toHaveBeenCalled();
});
it("reads closed files again and ignores a late read after activating a cached tab", async () => {
  const f = await fixture();
  await f.update({openPaths: [], metadata: f.metadata});
  await act(async () => {await f.open("main.tex");});
  expect(f.gateway.readFile).toHaveBeenCalledOnce();
  await f.update({openPaths: ["main.tex", "other.tex"], metadata: f.metadata});
  let resolve!: (file: Awaited<ReturnType<typeof f.gateway.readFile>>) => void;
  f.gateway.readFile.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
  let pending!: ReturnType<typeof f.open>;
  await act(async () => {pending = f.open("other.tex");});
  await act(async () => {await f.open("main.tex");});
  await act(async () => {resolve({relativePath: parseManuscriptPath("other.tex"), content: "late", sha256: "a".repeat(64)}); await pending;});
  expect(f.publish).toHaveBeenLastCalledWith("original"); expect(f.publish).not.toHaveBeenCalledWith("late");
});

it("uses freshly checked project metadata before React publishes the restored project state", async () => {
  const f = await fixture();
  await f.update({openPaths: [], metadata: []});
  await act(async () => {await f.activate("main.tex", f.metadata, ["main.tex"]);});
  expect(f.gateway.readFile).not.toHaveBeenCalled(); expect(f.publish).toHaveBeenLastCalledWith("original");
});

it.each(["notes/research.ranote", "references.bib"])("retains an open auxiliary file %s until its hash changes or its tab closes", async path => {
  const f = await fixture(), metadata = [{...f.metadata[0]!, relativePath: parseManuscriptPath(path)}];
  await f.update({openPaths: [path], metadata});
  await act(async () => {await f.open(path); await f.open(path);});
  expect(f.gateway.readFile).toHaveBeenCalledOnce();
  const changed = [{...metadata[0]!, sha256: "b".repeat(64)}];
  f.gateway.readFile.mockResolvedValueOnce({relativePath: parseManuscriptPath(path), content: "updated", sha256: "b".repeat(64)});
  await f.update({openPaths: [path], metadata: changed});
  await act(async () => {await f.open(path);});
  expect(f.gateway.readFile).toHaveBeenCalledTimes(2); expect(f.publish).toHaveBeenLastCalledWith("updated");
  await f.update({openPaths: [], metadata: changed});
  await act(async () => {await f.open(path);});
  expect(f.gateway.readFile).toHaveBeenCalledTimes(3);
});
