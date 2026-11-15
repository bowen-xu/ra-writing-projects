/** @vitest-environment happy-dom */
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentApplicationState, AgentPendingWritingUndoPage, AgentPendingWritingUndoEntry } from "@research-assistant/core/agent";
import type { AgentPendingWritingUndoGateway } from "@research-assistant/data/agent";
import { useWritingUndoRecovery } from "./useWritingUndoRecovery";
import type { useWritingProposalApplication } from "./useWritingProposalApplication";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({ notify: { warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function journal(manuscriptId: string, id = 1): AgentPendingWritingUndoEntry {
  const scope = { manuscriptId, conversationId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID() };
  const undoId = crypto.randomUUID();
  return { id, undo: { schemaVersion: 1, originalScope: scope, undoId, result: {
    kind: "state", schemaVersion: 1, scope: { ...scope, operationId: undoId }, status: "prepared",
    files: [{ path: "main.tex", phase: "pending", target: { kind: "disk" } }],
  } } };
}
const page = (manuscriptId: string, items: readonly AgentPendingWritingUndoEntry[] = [], nextCursor: number | null = null): AgentPendingWritingUndoPage =>
  ({ schemaVersion: 1, manuscriptId, items, nextCursor });
function delayed<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const manuscriptId = crypto.randomUUID(), entry = journal(manuscriptId);
  const discovery = { list: vi.fn<AgentPendingWritingUndoGateway["list"]>(async request => page(request.manuscriptId, [entry])) };
  const gateway = { find: vi.fn(async () => entry.undo), execute: vi.fn(async () => entry.undo) };
  const actions = { undo: vi.fn(), startUndo: vi.fn(), resumeUndo: vi.fn(), recoverUndo: vi.fn(), rollbackUndo: vi.fn(), cancelUndo: vi.fn() };
  const host = document.createElement("div"); document.body.append(host);
  let root: Root = createRoot(host), api!: ReturnType<typeof useWritingUndoRecovery>;
  const workspace = {};
  function Harness({ manuscript = manuscriptId, ready = true, identity = workspace }: { manuscript?: string; ready?: boolean; identity?: object }) {
    api = useWritingUndoRecovery(manuscript, ready, gateway, actions as unknown as ReturnType<typeof useWritingProposalApplication>, discovery, identity);
    return <>{api.feedback}</>;
  }
  const render = async (manuscript = manuscriptId, ready = true, identity = workspace) => {
    await act(async () => root.render(<Harness manuscript={manuscript} ready={ready} identity={identity} />));
  };
  const remount = async () => { await act(async () => root.unmount()); root = createRoot(host); await render(); };
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text)!;
  return { manuscriptId, entry, discovery, gateway, actions, host, render, remount, button, api: () => api };
}
it("discovers existing Undo identities after workspace remount without starting commands", async () => {
  const f = await fixture();
  await f.render(); await f.remount();
  expect(f.discovery.list.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ manuscriptId: f.manuscriptId, after: null, limit: 64 }]));
  expect(f.api().pending).toBe(true);
  expect(f.button("取消未执行撤销")).toBeDefined();
  for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled();
  expect(f.gateway.execute).not.toHaveBeenCalled();
  f.actions.cancelUndo.mockResolvedValue({ kind: "state", state: { ...f.entry.undo.result, status: "rolledBack" } });
  await act(async () => f.button("取消未执行撤销").click());
  expect(f.actions.cancelUndo).toHaveBeenCalledWith(f.entry.undo.originalScope, f.entry.undo.undoId);
  expect(f.api().pending).toBe(false);
});
it("blocks subsequent delivery during initial discovery and failed reads, then permits explicit retry", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingUndoPage>();
  f.discovery.list.mockReturnValueOnce(wait.promise).mockRejectedValueOnce(new Error("offline"));
  await f.render();
  expect(f.api().pending).toBe(true); expect(f.host.querySelector(".writing-undo-recovery")).toBeNull();
  await act(async () => wait.resolve(page(f.manuscriptId)));
  expect(f.api().pending).toBe(false);
  await f.render(f.manuscriptId, true, {});
  expect(f.api().pending).toBe(true); expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining("未能读取"), expect.anything());
  f.discovery.list.mockResolvedValueOnce(page(f.manuscriptId));
  await act(async () => f.button("重新读取撤销记录").click());
  expect(f.api().pending).toBe(false); expect(f.gateway.execute).not.toHaveBeenCalled();
});
it("paginates all identities and retains partial discovery after a later-page failure", async () => {
  const f = await fixture(), other = journal(f.manuscriptId, 2);
  f.discovery.list.mockResolvedValueOnce(page(f.manuscriptId, [f.entry], 1)).mockRejectedValueOnce(new Error("offline"));
  await f.render();
  expect(f.discovery.list.mock.calls[1]).toEqual([{ manuscriptId: f.manuscriptId, after: 1, limit: 64 }]);
  expect(f.button("取消未执行撤销").disabled).toBe(true);
  f.discovery.list.mockResolvedValueOnce(page(f.manuscriptId, [f.entry], 1)).mockResolvedValueOnce(page(f.manuscriptId, [other]));
  await act(async () => f.button("重新读取撤销记录").click());
  expect(f.host.querySelectorAll('[aria-label="文件撤销恢复"]')).toHaveLength(2);
  expect(f.button("取消未执行撤销").disabled).toBe(false);
});
it("ignores delayed old-manuscript pages and discovers without requiring the editor to be ready", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingUndoPage>(), otherId = crypto.randomUUID();
  f.discovery.list.mockReturnValueOnce(wait.promise).mockResolvedValueOnce(page(otherId));
  await f.render(); await f.render(otherId, false);
  await act(async () => wait.resolve(page(f.manuscriptId, [f.entry])));
  expect(f.api().pending).toBe(false); expect(f.host.textContent).toBe("");
  await f.render(f.manuscriptId, false);
  expect(f.button("取消未执行撤销").disabled).toBe(true);
  await f.render();
  expect(f.discovery.list).toHaveBeenCalledTimes(3);
  expect(f.button("取消未执行撤销").disabled).toBe(false);
});
it("does not resurrect a completed local command from a delayed discovery snapshot", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingUndoPage>();
  f.discovery.list.mockReturnValueOnce(wait.promise);
  await f.render();
  const state = { ...f.entry.undo.result, status: "applied" } as AgentApplicationState;
  await act(async () => f.api().record({ scope: f.entry.undo.originalScope, undoId: f.entry.undo.undoId, result: { kind: "state", state } }));
  await act(async () => wait.resolve(page(f.manuscriptId, [f.entry])));
  expect(f.api().pending).toBe(false); expect(f.host.textContent).toBe("");
});
it("preserves newer observations and terminal results awaiting host save across scans", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingUndoPage>();
  f.discovery.list.mockReturnValueOnce(wait.promise);
  await f.render();
  const state = { ...f.entry.undo.result, status: "applied" } as AgentApplicationState;
  await act(async () => f.api().record({ scope: f.entry.undo.originalScope, undoId: f.entry.undo.undoId, result: { kind: "unconfirmed", state } }));
  await act(async () => wait.resolve(page(f.manuscriptId, [f.entry])));
  expect(f.button("重试保存撤销结果")).toBeDefined();
  f.discovery.list.mockResolvedValueOnce(page(f.manuscriptId));
  await f.render(f.manuscriptId, true, {});
  expect(f.button("重试保存撤销结果")).toBeDefined(); expect(f.api().pending).toBe(true);
});
