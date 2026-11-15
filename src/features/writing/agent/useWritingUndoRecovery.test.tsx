/** @vitest-environment happy-dom */
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentApplicationState, AgentUndoResponse } from "@research-assistant/core/agent";
import { useWritingUndoRecovery } from "./useWritingUndoRecovery";
import type { useWritingProposalApplication } from "./useWritingProposalApplication";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({ notify: { warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(phases: readonly ("pending" | "acknowledged" | "dispatched")[] = ["acknowledged", "pending"]) {
  const scope = { manuscriptId: crypto.randomUUID(), conversationId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID() };
  const undoId = crypto.randomUUID();
  let stored: AgentApplicationState | null = { kind: "state", schemaVersion: 1, scope: { ...scope, operationId: undoId }, status: "recoveryRequired",
    files: phases.map((phase, i) => ({ path: `file${i}.tex`, phase, target: { kind: "disk" } })) };
  const response = (): AgentUndoResponse => ({ schemaVersion: 1, originalScope: scope, undoId, result: stored });
  const gateway = { find: vi.fn(async () => response()), execute: vi.fn(async () => response()) };
  const actions = { undo: vi.fn(), startUndo: vi.fn(), resumeUndo: vi.fn(), recoverUndo: vi.fn(), rollbackUndo: vi.fn(), cancelUndo: vi.fn() };
  const discovery = { list: vi.fn(async ({ manuscriptId }: { manuscriptId: string }) =>
    ({ schemaVersion: 1 as const, manuscriptId, items: [], nextCursor: null })) };
  const host = document.createElement("div"); document.body.append(host); const root: Root = createRoot(host);
  let api!: ReturnType<typeof useWritingUndoRecovery>;
  function Harness({ manuscriptId = scope.manuscriptId, ready = true } = {}) {
    api = useWritingUndoRecovery(manuscriptId, ready, gateway, actions as unknown as ReturnType<typeof useWritingProposalApplication>, discovery, gateway);
    return <>{api.feedback}</>;
  }
  const render = async (manuscriptId = scope.manuscriptId, ready = true) => { await act(async () => root.render(<Harness manuscriptId={manuscriptId} ready={ready} />)); };
  await render();
  await act(async () => api.record({ scope, undoId, result: { kind: "unconfirmed", state: stored } }));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text)!;
  const click = async (text: string) => { await act(async () => button(text).click()); };
  return { scope, undoId, host, actions, gateway, response, button, click, render, api: () => api,
    state: () => stored!, setState: (state: AgentApplicationState | null) => { stored = state; } };
}
it("refreshes original Undo progress without dispatching or claiming formal save", async () => {
  const f = await fixture();
  f.setState({ ...f.state(), status: "applied" });
  await f.click("刷新撤销状态");
  expect(f.api().pending).toBe(true);
  expect(f.button("重试保存撤销结果")).toBeDefined();
  for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled();
  expect(f.gateway.execute).toHaveBeenCalledWith({ scope: f.scope, undoId: f.undoId, command: { action: "read" } });
  f.actions.undo.mockResolvedValue({ kind: "state", state: f.state() });
  await f.click("重试保存撤销结果");
  expect(f.actions.undo).toHaveBeenCalledWith(f.scope, f.undoId);
  expect(f.api().pending).toBe(false);
});
it("rechecks the journal before canceling and rejects a newly dispatched target", async () => {
  const f = await fixture(["pending"]);
  f.setState({ ...f.state(), files: [{ ...f.state().files[0]!, phase: "dispatched" }] });
  await f.click("取消未执行撤销");
  expect(f.actions.cancelUndo).not.toHaveBeenCalled();
  expect(f.button("核对撤销结果")).toBeDefined();
  expect(f.api().pending).toBe(true);
});
it("reconciles known dispatched receipts without automatically resuming pending work", async () => {
  const f = await fixture(["dispatched", "pending"]);
  const acknowledged = { ...f.state(), files: [{ ...f.state().files[0]!, phase: "acknowledged" as const }, f.state().files[1]!] };
  f.actions.recoverUndo.mockResolvedValue({ kind: "state", state: acknowledged });
  await f.click("核对撤销结果");
  expect(f.actions.recoverUndo).toHaveBeenCalledWith(f.scope, f.undoId, "file0.tex");
  expect(f.actions.resumeUndo).not.toHaveBeenCalled();
  expect(f.button("继续原撤销")).toBeDefined();
  f.setState(acknowledged);
  f.actions.resumeUndo.mockResolvedValue({ kind: "state", state: { ...acknowledged, status: "applied" } });
  await f.click("继续原撤销");
  expect(f.actions.resumeUndo).toHaveBeenCalledWith(f.scope, f.undoId);
  expect(f.api().pending).toBe(false);
});
it("keeps the final reconciled receipt pending until formal save is confirmed", async () => {
  const f = await fixture(["dispatched"]);
  const applied = { ...f.state(), status: "applied" as const, files: [{ ...f.state().files[0]!, phase: "acknowledged" as const }] };
  f.actions.recoverUndo.mockResolvedValue({ kind: "state", state: applied });
  await f.click("核对撤销结果");
  expect(f.api().pending).toBe(true);
  expect(f.button("重试保存撤销结果")).toBeDefined();
  expect(f.actions.undo).not.toHaveBeenCalled();
  f.setState(applied);
  f.actions.undo.mockResolvedValueOnce({ kind: "unconfirmed", state: applied });
  await f.click("重试保存撤销结果");
  expect(f.api().pending).toBe(true);
  f.actions.undo.mockResolvedValueOnce({ kind: "state", state: applied });
  await f.click("重试保存撤销结果");
  expect(f.api().pending).toBe(false);
  expect(f.actions.undo.mock.calls).toEqual([[f.scope, f.undoId], [f.scope, f.undoId]]);
});
it("queries the original Undo record immediately and clears only protected settlement", async () => {
  const f = await fixture(); const query = f.api().hasPending;
  expect(query()).toBe(true);
  const applied = {...f.state(), status: "applied" as const};
  await act(async () => {
    f.api().record({scope: f.scope, undoId: f.undoId, result: {kind: "unconfirmed", state: applied}});
    expect(query()).toBe(true);
    f.api().record({scope: f.scope, undoId: f.undoId, result: {kind: "state", state: applied}});
    expect(query()).toBe(false);
    f.api().record({scope: f.scope, undoId: f.undoId, result: {kind: "unconfirmed", state: null}});
    expect(query()).toBe(true);
  });
  expect(f.api().pending).toBe(true);
});
it("retries an unconfirmed admission with its retained Undo identity", async () => {
  const f = await fixture(); const initial = f.state(); f.setState(null);
  await f.click("刷新撤销状态");
  f.actions.undo.mockResolvedValueOnce({ kind: "unconfirmed", state: null });
  await f.click("重试原撤销");
  expect(f.api().pending).toBe(true);
  f.actions.undo.mockResolvedValueOnce({ kind: "state", state: { ...initial, status: "applied",
    files: initial.files.map(file => ({ ...file, phase: "acknowledged" })) } });
  await f.click("重试原撤销");
  expect(f.actions.undo.mock.calls).toEqual([[f.scope, f.undoId], [f.scope, f.undoId]]);
  expect(f.api().pending).toBe(false);
});
it("retains failed compensation and retries the same original identity", async () => {
  const f = await fixture();
  f.actions.rollbackUndo.mockResolvedValue({ kind: "unconfirmed", state: f.state() });
  await f.click("恢复撤销前内容");
  expect(f.api().pending).toBe(true);
  f.actions.rollbackUndo.mockResolvedValue({ kind: "state", state: { ...f.state(), status: "rolledBack" } });
  await f.click("恢复撤销前内容");
  expect(f.actions.rollbackUndo.mock.calls).toEqual([[f.scope, f.undoId], [f.scope, f.undoId]]);
  expect(f.api().pending).toBe(false);
});
it("keeps recovery across manuscript switches and ignores delayed old-view actions", async () => {
  const f = await fixture();
  let resolve!: (value: AgentUndoResponse) => void;
  f.gateway.execute.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => f.button("继续原撤销").click());
  await f.render(crypto.randomUUID());
  expect(f.host.textContent).toBe("");
  await act(async () => resolve(f.response()));
  expect(f.actions.resumeUndo).not.toHaveBeenCalled();
  await f.render();
  expect(f.api().pending).toBe(true);
  expect(f.button("继续原撤销")).toBeDefined();
});
it("serializes rapid clicks and respects the unavailable workspace", async () => {
  const f = await fixture();
  let resolve!: (value: AgentUndoResponse) => void;
  f.gateway.execute.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { f.button("刷新撤销状态").click(); f.button("刷新撤销状态").click(); });
  expect(f.gateway.execute).toHaveBeenCalledTimes(1);
  await act(async () => resolve(f.response()));
  await f.render(f.scope.manuscriptId, false);
  await f.click("继续原撤销");
  expect(f.actions.resumeUndo).not.toHaveBeenCalled();
});
it("retains unreadable or mismatched journals and never dispatches", async () => {
  const f = await fixture();
  f.gateway.execute.mockRejectedValueOnce(new Error("transport"));
  await f.click("继续原撤销");
  expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("仍未确认"), expect.anything());
  f.setState({ ...f.state(), scope: { ...f.state().scope, operationId: crypto.randomUUID() } });
  await f.click("继续原撤销");
  expect(f.actions.resumeUndo).not.toHaveBeenCalled();
  expect(f.api().pending).toBe(true);
});
it("cancels a never-created Undo only after native absence is observed", async () => {
  const f = await fixture(); f.setState(null);
  await f.click("刷新撤销状态");
  await f.click("取消未开始撤销");
  expect(f.gateway.execute).toHaveBeenCalledTimes(2);
  for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled();
  expect(f.api().pending).toBe(false);
});
