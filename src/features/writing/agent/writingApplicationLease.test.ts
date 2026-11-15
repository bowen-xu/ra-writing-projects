/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { writingEditorIdentity } from "../editor/editorSession";
import { createWritingEditorSessionPort } from "../editor/editorSessionPort";
import { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import type { WritingGateway } from "../gateway/writingGateway";
import type { WritingSaveSnapshot } from "../useWritingPersistence";
import { acquireWritingApplicationLease } from "./writingApplicationLease";

const views: EditorView[] = [];
afterEach(() => {for (const view of views.splice(0)) view.destroy();});
function fixture() {
  const scope = {conversationId: crypto.randomUUID(), manuscriptId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID()};
  const view = new EditorView({state: EditorState.create({doc: "draft", extensions: [history(), writingEditorIdentity]})});
  views.push(view);
  const port = createWritingEditorSessionPort(view, `${scope.manuscriptId}:main.tex`);
  let host = {manuscriptId: scope.manuscriptId, activePath: "main.tex", ready: true, port};
  let snapshot: WritingSaveSnapshot = {manuscriptId: scope.manuscriptId, relativePath: "main.tex", content: "draft", contentHash: "a".repeat(64), saveState: "dirty"};
  const resume = vi.fn();
  const paused = Object.assign(resume, {readSnapshot: () => snapshot});
  const persistence = Object.assign(vi.fn(async () => false), {pause: vi.fn(async () => paused)});
  const access = createExclusiveWritingGateway({} as WritingGateway);
  const commit = vi.fn(() => {expect(access.isExclusive()).toBe(false); expect(resume).not.toHaveBeenCalled();});
  const prepareRefresh = vi.fn(async () => commit);
  const options = {scope, persistence, access, readHost: () => host, prepareRefresh};
  return {options, port, view, snapshot: (value: WritingSaveSnapshot) => {snapshot = value;},
    changeHost: () => {host = {...host, activePath: "other.tex"};}, resume, commit, prepareRefresh};
}

it("captures the live editor baseline and commits refreshed metadata only after source release", async () => {
  const f = fixture(), baseline = f.port.read()!;
  const lease = await acquireWritingApplicationLease(f.options);
  expect(lease?.buffers).toEqual([{path: "main.tex", expectedDiskSha256: "a".repeat(64), text: "draft", sessionId: baseline.sessionId, revision: baseline.revision}]);
  expect(f.options.access.isExclusive()).toBe(true);
  f.port.apply({operationId: f.options.scope.operationId, expected: baseline, text: "accepted"});
  const selection = f.view.state.selection.toJSON();
  expect(lease?.isCurrent()).toBe(true);
  await lease?.refresh(); expect(f.commit).not.toHaveBeenCalled();
  lease?.release(); lease?.release();
  expect(f.commit).toHaveBeenCalledTimes(1); expect(f.resume).toHaveBeenCalledTimes(1);
  expect(lease?.isCurrent()).toBe(false);
  expect(f.view.state.doc.toString()).toBe("accepted");
  expect(f.view.state.selection.toJSON()).toEqual(selection);
  expect(undo(f.view)).toBe(true); expect(f.view.state.doc.toString()).toBe("draft");
});

it("refuses stale or failed persistence snapshots and releases both boundaries", async () => {
  for (const mismatch of ["text", "hash", "error"] as const) {
    const f = fixture();
    f.snapshot({manuscriptId: f.options.scope.manuscriptId, relativePath: "main.tex", content: mismatch === "text" ? "old" : "draft",
      contentHash: mismatch === "hash" ? undefined : "a".repeat(64), saveState: mismatch === "error" ? "error" : "dirty"});
    expect(await acquireWritingApplicationLease(f.options)).toBeNull();
    expect(f.options.access.isExclusive()).toBe(false); expect(f.resume).toHaveBeenCalledTimes(1);
  }
});

it("drops prepared UI updates after host replacement or port disposal", async () => {
  for (const mode of ["switch", "dispose", "unreadable"]) {
    const f = fixture();
    const lease = await acquireWritingApplicationLease(f.options);
    await lease?.refresh();
    if (mode === "dispose") f.port.dispose();
    else if (mode === "unreadable") vi.spyOn(f.port, "read").mockImplementation(() => {throw new Error("view unavailable");});
    else f.changeHost();
    expect(lease?.isCurrent()).toBe(false);
    lease?.release();
    expect(f.commit).not.toHaveBeenCalled(); expect(f.resume).toHaveBeenCalledTimes(1);
    expect(f.options.access.isExclusive()).toBe(false);
  }
});

it("cleans up a failed second acquisition and a refresh failure without overwriting the editor", async () => {
  const f = fixture(), release = await f.options.access.acquire();
  await expect(acquireWritingApplicationLease(f.options)).rejects.toThrow("另一项提案");
  expect(f.resume).toHaveBeenCalledTimes(1); release();
  const lease = await acquireWritingApplicationLease(f.options);
  f.prepareRefresh.mockRejectedValueOnce(new Error("metadata unavailable"));
  await expect(lease?.refresh()).rejects.toThrow("metadata unavailable");
  lease?.release();
  expect(f.options.access.isExclusive()).toBe(false);
  expect(f.view.state.doc.toString()).toBe("draft"); expect(f.commit).not.toHaveBeenCalled();
});

it("keeps admission buffers frozen while exposing current live bytes only under the lease",async()=>{
  const f=fixture(), lease=await acquireWritingApplicationLease(f.options);
  const before=lease!.buffers[0]!;
  f.view.dispatch({changes:{from:0,insert:"restored "}});
  expect(lease!.buffers[0]).toEqual(before);
  const live=lease!.readBuffers!(); if (!live) throw new Error("expected live lease");
  expect(live[0]).toMatchObject({text:"restored draft",expectedDiskSha256:before.expectedDiskSha256});
  expect(live[0]!.revision).not.toBe(before.revision);
  lease!.release();expect(lease!.readBuffers!()).toBeNull();
});

it("includes every file buffer in native admission and preserves frozen versions while reading live text", async () => {
  const f = fixture(), active = f.port.read()!;
  const other = { path: "second.tex", expectedDiskSha256: "b".repeat(64), sessionId: "second-session", revision: "second-revision", text: "unsaved second" };
  let buffers = [{ path: "main.tex", expectedDiskSha256: "a".repeat(64), sessionId: active.sessionId, revision: active.revision, text: active.text }, other];
  const lease = await acquireWritingApplicationLease({ ...f.options, readFileBuffers: () => buffers });
  expect(lease?.buffers).toEqual(buffers);
  buffers = [buffers[0]!, { ...other, text: "new second", revision: "new-revision" }];
  expect(lease?.readBuffers?.()?.[1]).toMatchObject({ text: "new second", revision: "new-revision" });
  expect(lease?.buffers[1]?.text).toBe("unsaved second");
  lease?.release();
});

it.each(["missing-active", "duplicate", "invalid-hash"])("rejects incomplete file admission (%s) and releases saving", async (mode) => {
  const f = fixture(), active = f.port.read()!;
  const buffer = { path: "main.tex", expectedDiskSha256: "a".repeat(64), sessionId: active.sessionId, revision: active.revision, text: active.text };
  const buffers = mode === "missing-active" ? [] : mode === "duplicate" ? [buffer, buffer] : [{ ...buffer, expectedDiskSha256: "unknown" }];
  expect(await acquireWritingApplicationLease({ ...f.options, readFileBuffers: () => buffers })).toBeNull();
  expect(f.options.access.isExclusive()).toBe(false);
  expect(f.resume).toHaveBeenCalledOnce();
});

it.each(["session", "disk", "removed"])("invalidates a lease if a background file owner changes (%s)", async (mode) => {
  const f = fixture(), active = f.port.read()!;
  const buffer = { path: "main.tex", expectedDiskSha256: "a".repeat(64), sessionId: active.sessionId, revision: active.revision, text: active.text };
  const other = { ...buffer, path: "second.tex", sessionId: "other", text: "background" };
  let buffers = [buffer, other];
  const lease = await acquireWritingApplicationLease({ ...f.options, readFileBuffers: () => buffers });
  expect(lease?.isCurrent()).toBe(true);
  await lease?.refresh();
  buffers = mode === "removed" ? [buffer] : [buffer, { ...other,
    ...(mode === "session" ? { sessionId: "replacement" } : { expectedDiskSha256: "b".repeat(64) }) }];
  expect(lease?.isCurrent()).toBe(false);
  expect(lease?.readBuffers?.()).toBeNull();
  lease?.release();
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.resume).toHaveBeenCalledOnce();
});
