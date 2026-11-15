/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentApplicationScope, AgentApplicationState, AgentEditorRestorationRequest, AgentUndoRequest } from "@research-assistant/core/agent";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { parseManuscriptPath } from "@research-assistant/writing";
import { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import type { WritingGateway } from "../gateway/writingGateway";
import { useWritingProposalApplication } from "./useWritingProposalApplication";

let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); });

async function fixture() {
  const scope: AgentApplicationScope = { conversationId: crypto.randomUUID(), manuscriptId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID() };
  const files = new WritingFileSessions();
  const open = (path: string) => files.open({ manuscriptId: scope.manuscriptId, relativePath: path }, `before ${path}`, "a".repeat(64));
  const active = open("open.tex"), background = [open("second.tex"), open("third.tex")];
  const metadata = { listFiles: vi.fn(async () => []), listDirectories: vi.fn(async () => []),
    listCitationBindings: vi.fn(async () => []), getBibliographyStatus: vi.fn(async () => ({})), listManuscripts: vi.fn(async () => []) };
  const access = createExclusiveWritingGateway(metadata as unknown as WritingGateway);
  const resume = Object.assign(vi.fn(), { readSnapshot: () => ({ ...active.identity, content: active.read().content,
    contentHash: active.savedSha256!, saveState: "dirty" as const }) });
  const persistence = Object.assign(vi.fn(async () => true), { pause: vi.fn(async () => resume) });
  const fileSaves = { save: vi.fn(async (identity: { manuscriptId: string; relativePath: string }) => ({
    relativePath: parseManuscriptPath(identity.relativePath), content: files.get(identity)!.read().content, sha256: "a".repeat(64) })) };
  const native = { applications: { find: vi.fn(), execute: vi.fn() }, restorations: { execute: vi.fn() },
    undos: { find: vi.fn(), execute: vi.fn() }, undoRestorations: vi.fn() };
  const restoreUndo = { execute: vi.fn() };
  native.undoRestorations.mockReturnValue(restoreUndo);
  const resolveFilePort = vi.fn((value: AgentApplicationScope, path: string) =>
    files.get({ manuscriptId: value.manuscriptId, relativePath: path })?.applicationPort ?? null);
  let ready = true;
  let application!: ReturnType<typeof useWritingProposalApplication>;
  function Host() {
    application = useWritingProposalApplication({ access, persistence, fileSaves,
      editor: { apply: vi.fn(), recover: vi.fn() }, agentGateways: native, resolveFilePort,
      readFileBuffers: (manuscriptId) => files.readBuffers(manuscriptId),
      readHost: () => ({ manuscriptId: scope.manuscriptId, activePath: "open.tex", port: active.applicationPort, ready }),
      publishMetadata: vi.fn() });
    return null;
  }
  await act(async () => root.render(<Host />));
  function applied(operationId: string): AgentApplicationState {
    return { kind: "state", schemaVersion: 1, scope: { ...scope, operationId }, status: "recoveryRequired",
      files: background.map((session) => {
        const before = session.applicationPort.read()!;
        session.applicationPort.apply({ operationId, expected: before, text: `after ${session.identity.relativePath}` });
        return { path: session.identity.relativePath, phase: "acknowledged", target: {
          kind: "editor", sessionId: before.sessionId, revision: before.revision, resultRevision: session.applicationPort.read()!.revision } };
      }) };
  }
  return { scope, files, active, background, native, restoreUndo, resolveFilePort, application, applied, resume, fileSaves,
    invalidate: () => { ready = false; } };
}

function restorationGateway(f: Awaited<ReturnType<typeof fixture>>, initial: AgentApplicationState, undoing: boolean) {
  let state = initial;
  const gateway = undoing ? f.restoreUndo : f.native.restorations;
  gateway.execute.mockImplementation(async (request: AgentEditorRestorationRequest) => {
    const path = request.action === "read" ? request.path : request.action === "prepare" ? request.current.path : request.actual.path;
    expect(request.scope).toEqual(initial.scope);
    if (request.action === "read") return { kind: "state", schemaVersion: 1, application: state, path, restoration: null };
    if (request.action === "prepare") return { kind: "edit", schemaVersion: 1, scope: initial.scope,
      restoreId: request.restoreId, expected: request.current, text: `before ${path}` };
    const file = state.files.find((file) => file.path === path)!;
    if (file.target.kind !== "editor") throw new Error("Expected editor target");
    expect(request.actual.text).toBe(`before ${path}`);
    state = { ...state, files: state.files.map((file) => file.path === path ? { ...file, phase: "restored" } : file) };
    return { kind: "state", schemaVersion: 1, application: state, path, restoration: { id: request.restoreId,
      sessionId: file.target.sessionId, expectedRevision: file.target.resultRevision, resultRevision: request.actual.revision } };
  });
  return () => state;
}

it.each([false, true])("restores every background editor through its file port (undo rollback=%s)", async (undoing) => {
  const f = await fixture(), undoId = crypto.randomUUID();
  const state = f.applied(undoing ? undoId : f.scope.operationId);
  const current = restorationGateway(f, state, undoing);
  const finish = () => ({ ...current(), status: "rolledBack" as const });
  f.native.applications.execute.mockImplementation(async ({ action }) => action === "read" || action === "prepareRollback" ? current() : finish());
  f.native.undos.execute.mockImplementation(async (request: AgentUndoRequest) => ({ schemaVersion: 1, originalScope: f.scope, undoId,
    result: request.command.action === "rollbackDisk" ? finish() : current() }));
  const result = undoing ? await f.application.rollbackUndo(f.scope, undoId) : await f.application.rollback(f.scope);
  expect(result.kind === "state" && result.state.status).toBe("rolledBack");
  for (const session of f.background) expect(session.read().content).toBe(`before ${session.identity.relativePath}`);
  expect(f.active.read().content).toBe("before open.tex");
  expect(f.resolveFilePort.mock.calls.map(([, path]) => path)).toContain("second.tex");
  expect(f.resolveFilePort.mock.calls.map(([, path]) => path)).toContain("third.tex");
  expect(f.resume).toHaveBeenCalledOnce();
  expect(f.fileSaves.save.mock.calls.map(([identity]) => identity)).toEqual(f.background.map(session => session.identity));
});

it("applies a completed-operation undo to all background editors without changing the active file", async () => {
  const f = await fixture(), undoId = crypto.randomUUID();
  let state: AgentApplicationState = { kind: "state", schemaVersion: 1, scope: { ...f.scope, operationId: undoId }, status: "prepared",
    files: f.background.map((session) => ({ path: session.identity.relativePath, phase: "pending", target: {
      kind: "editor", sessionId: session.applicationPort.read()!.sessionId, revision: session.applicationPort.read()!.revision, resultRevision: null } })) };
  let exists = false;
  f.native.undos.execute.mockImplementation(async (request: AgentUndoRequest) => {
    const command = request.command;
    if (command.action === "read" && !exists) return { schemaVersion: 1, originalScope: f.scope, undoId, result: null };
    if (command.action === "prepare") exists = true;
    if (command.action === "start") state = { ...state, status: "applying" };
    if (command.action === "prepareEditor") return { schemaVersion: 1, originalScope: f.scope, undoId, result: {
      kind: "edit", schemaVersion: 1, scope: state.scope, expected: command.current, text: `undone ${command.current.path}` } };
    if (command.action === "confirmEditor") {
      state = { ...state, files: state.files.map((file) => file.path === command.actual.path && file.target.kind === "editor"
        ? { ...file, phase: "acknowledged", target: { ...file.target, resultRevision: command.actual.revision } } : file) };
      if (state.files.every((file) => file.phase === "acknowledged")) state = { ...state, status: "applied" };
    }
    return { schemaVersion: 1, originalScope: f.scope, undoId, result: state };
  });
  const result = await f.application.undo(f.scope, undoId);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  for (const session of f.background) expect(session.read().content).toBe(`undone ${session.identity.relativePath}`);
  expect(f.fileSaves.save.mock.calls.map(([identity]) => identity)).toEqual(f.background.map(session => session.identity));
  expect(f.active.read().content).toBe("before open.tex");
});

it("keeps rollback unconfirmed when formal saving of a restored background file fails", async () => {
  const f = await fixture(), state = f.applied(f.scope.operationId);
  const current = restorationGateway(f, state, false);
  f.native.applications.execute.mockImplementation(async ({ action }) => action === "read" || action === "prepareRollback" ? current() : { ...current(), status: "rolledBack" });
  f.fileSaves.save.mockRejectedValueOnce(new Error("synthetic file write failure"));
  expect(await f.application.rollback(f.scope)).toMatchObject({ kind: "unconfirmed", state: { status: "rolledBack" } });
  for (const session of f.background) expect(session.read().content).toBe(`before ${session.identity.relativePath}`);
  expect(f.fileSaves.save).toHaveBeenCalledTimes(2);
});

it("recovers a background undo receipt without replaying the edit", async () => {
  const f = await fixture(), undoId = crypto.randomUUID();
  const applied = f.applied(undoId), file = applied.files[0]!;
  const state = { ...applied, files: [{ ...file, phase: "dispatched" as const }] };
  const port = f.background[0]!.applicationPort, apply = vi.spyOn(port, "apply");
  f.native.undos.execute.mockImplementation(async (request: AgentUndoRequest) => ({ schemaVersion: 1, originalScope: f.scope, undoId,
    result: request.command.action === "confirmEditor" ? { ...state, status: "applied", files: [file] } : state }));
  const result = await f.application.recoverUndo(f.scope, undoId, file.path);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(apply).not.toHaveBeenCalled();
  expect(port.read()!.text).toBe("after second.tex");
  expect(f.active.read().content).toBe("before open.tex");
});

it("does not restore a background file after the manuscript becomes unavailable", async () => {
  const f = await fixture(), state = f.applied(f.scope.operationId);
  restorationGateway(f, state, false);
  f.native.applications.execute.mockResolvedValue(state);
  f.native.restorations.execute.mockImplementationOnce(async () => {
    f.invalidate();
    return { kind: "state", schemaVersion: 1, application: state, path: "third.tex", restoration: null };
  });
  expect((await f.application.rollback(f.scope)).kind).not.toBe("state");
  for (const session of f.background) expect(session.read().content).toBe(`after ${session.identity.relativePath}`);
  expect(f.native.restorations.execute).toHaveBeenCalledOnce();
  expect(f.resume).toHaveBeenCalledOnce();
});
