import { expect, it, vi } from "vitest";
import type { AgentApplicationState, AgentApplicationScope } from "@research-assistant/core/agent";
import { createWritingCardUndo } from "./writingCardUndo";
import type { WritingProposalApplicationGateways } from "./useWritingProposalApplication";

function fixture() {
  const scope = { manuscriptId: crypto.randomUUID(), conversationId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID() };
  const state: AgentApplicationState = { kind: "state", schemaVersion: 1, scope, status: "applied", files: [{ path: "main.tex", phase: "acknowledged", target: { kind: "disk" } }] };
  const find = vi.fn(async () => null as unknown), applications = { find: vi.fn(async () => state) };
  const gateways = { applications, undos: { find } } as unknown as WritingProposalApplicationGateways;
  const actions = { undo: vi.fn(async (_scope: AgentApplicationScope, _undoId: string) => ({ kind: "unconfirmed", state: null } as const)), startUndo: vi.fn(), resumeUndo: vi.fn(), recoverUndo: vi.fn() };
  const run = createWritingCardUndo(gateways, actions);
  return { scope, state, find, applications, actions, run, gateways };
}

it("retains the workspace undo identity when replies are lost and a chat is reopened", async () => {
  const f = fixture();
  await f.run(f.scope); await f.run(f.scope);
  expect(f.actions.undo).toHaveBeenCalledTimes(2);
  expect(f.actions.undo.mock.calls[0]).toEqual(f.actions.undo.mock.calls[1]);
  expect(f.actions.undo.mock.calls[0]?.[1]).not.toBe(f.scope.operationId);
});
it("adopts the persisted prepared undo instead of creating another operation", async () => {
  const f = fixture(), id = crypto.randomUUID();
  f.find.mockResolvedValue({ undoId: id, result: { ...f.state, status: "prepared", scope: { ...f.scope, operationId: id } } });
  f.actions.startUndo.mockResolvedValue({ kind: "state", state: f.state });
  await f.run(f.scope);
  expect(f.actions.startUndo).toHaveBeenCalledWith(f.scope, id);
  expect(f.actions.undo).not.toHaveBeenCalled();
});
it("reconciles dispatched results before resuming the original interrupted undo", async () => {
  const f = fixture(), id = crypto.randomUUID();
  const state = { ...f.state, status: "recoveryRequired", scope: { ...f.scope, operationId: id }, files: [{ path: "main.tex", phase: "dispatched", target: { kind: "disk" } }] };
  f.find.mockResolvedValue({ undoId: id, result: state });
  f.actions.recoverUndo.mockResolvedValue({ kind: "unconfirmed", state });
  await f.run(f.scope);
  expect(f.actions.recoverUndo).toHaveBeenCalledWith(f.scope, id, "main.tex");
  expect(f.actions.resumeUndo).not.toHaveBeenCalled();
  f.actions.recoverUndo.mockResolvedValue({ kind: "state", state: f.state });
  await f.run(f.scope);
  expect(f.actions.resumeUndo).toHaveBeenCalledWith(f.scope, id);
});
it("serializes the complete lookup and action, including a delayed native reply", async () => {
  const f = fixture();
  let resolve!: (value: AgentApplicationState) => void;
  f.applications.find.mockImplementation(() => new Promise(r => { resolve = r; }));
  const first = f.run(f.scope);
  expect(await f.run(f.scope)).toEqual({ kind: "busy" });
  resolve(f.state); await first;
  expect(f.actions.undo).toHaveBeenCalledTimes(1);
});
it("reports unresolved native identity to the file workspace", async () => {
  const f = fixture(), report = vi.fn();
  const run = createWritingCardUndo(f.gateways, f.actions, report);
  await run(f.scope);
  expect(report).toHaveBeenCalledWith({ scope: f.scope, undoId: f.actions.undo.mock.calls[0]![1], result: { kind: "unconfirmed", state: null } });
});
it("creates a new Undo only after an explicit click following a canceled inverse operation", async () => {
  const f = fixture(), id = crypto.randomUUID();
  f.find.mockResolvedValue({ undoId: id, result: { ...f.state, status: "rolledBack", scope: { ...f.scope, operationId: id } } });
  await f.run(f.scope); await f.run(f.scope);
  expect(f.actions.undo.mock.calls[0]![1]).not.toBe(id);
  expect(f.actions.undo.mock.calls[1]).toEqual(f.actions.undo.mock.calls[0]);
  expect(f.actions.startUndo).not.toHaveBeenCalled();
});
