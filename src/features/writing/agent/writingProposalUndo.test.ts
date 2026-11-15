import { expect, it, vi, type Mock } from "vitest";
import type { AgentApplicationState, AgentUndoRequest, AgentUndoCheckpointVersion } from "@research-assistant/core/agent";
import { createAgentUndoGateway } from "@research-assistant/data/agent";
import { createWritingProposalUndo } from "./writingProposalUndo";
function fixture() {
  const scope = { conversationId: crypto.randomUUID(), manuscriptId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID() }, undoId = crypto.randomUUID();
  const buffer = { path: "main.tex", sessionId: crypto.randomUUID(), revision: crypto.randomUUID() as string, text: "after", expectedDiskSha256: "a".repeat(64) };
  let saved: AgentApplicationState | null = null, valid = true, loseStart = false, loseDisk = false, diskOpened = false;
  let admission: ((state: AgentApplicationState) => AgentApplicationState) | undefined;
  const lease: { buffers: typeof buffer[]; prepareUndoResume?: () => Promise<readonly AgentUndoCheckpointVersion[]>;
    isCurrent: () => boolean; refresh: Mock<() => Promise<void>>; release: Mock<() => void> } = {
    buffers: [buffer], isCurrent: () => valid, refresh: vi.fn(async () => {}), release: vi.fn() };
  const fresh = (): AgentApplicationState => ({ kind: "state", schemaVersion: 1, scope: { ...scope, operationId: undoId }, status: "prepared", files: [
    { path: "main.tex", phase: "pending", target: { kind: "editor", sessionId: buffer.sessionId, revision: buffer.revision, resultRevision: null } },
    { path: "z.tex", phase: "pending", target: { kind: "disk" } },
  ] });
  const acknowledge = (path: string) => {
    if (!saved) throw new Error("no journal");
    const files = saved.files.map(f => f.path === path ? { ...f, phase: "acknowledged" as const, target: f.target.kind === "editor" ? { ...f.target, resultRevision: crypto.randomUUID() } : f.target } : f);
    saved = { ...saved, files, status: files.every(f => f.phase === "acknowledged") ? "applied" : "applying" };
    return saved;
  };
  const invoke = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const request = args.request as AgentUndoRequest, c = request.command;
    if (c.action === "prepare") saved = fresh();
    if (c.action === "start" || c.action === "resume") {
      saved = { ...saved!, status: "applying" };
      if (admission) saved = admission(saved);
      if (loseStart) throw new Error("start reply lost");
    }
    if (c.action === "applyDisk") {
      if (loseDisk) throw new Error("disk reply lost");
      acknowledge(c.path);
    }
    if (c.action === "defer" && saved?.status === "applying") saved = { ...saved, status: "recoveryRequired" };
    return { schemaVersion: 1, originalScope: scope, undoId, result: saved };
  });
  const editor = { apply: vi.fn(async (path: string) => ({ kind: "state" as const, state: acknowledge(path) })) };
  const acquire = vi.fn(async () => diskOpened ? { ...lease, buffers: [...lease.buffers, { ...buffer, path: "z.tex" }] } : lease);
  const app = createWritingProposalUndo(createAgentUndoGateway(invoke), () => editor, acquire);
  const actions = () => invoke.mock.calls.map(([, a]) => (a.request as AgentUndoRequest).command.action);
  const partial = (path = "main.tex") => {
    saved = fresh(); acknowledge(path);
    const target = saved.files[0]!.target;
    if (path === "main.tex") {
      if (target.kind !== "editor" || !target.resultRevision) throw new Error("missing receipt");
      buffer.revision = target.resultRevision;
    }
    saved = {...saved, status: "recoveryRequired"};
  };
  return { app, scope, undoId, lease, editor, acquire, actions, partial,
    admit: (transform: typeof admission) => { admission = transform; },
    recover: () => { saved = { ...fresh(), status: "recoveryRequired" }; },
    loseStart: () => { loseStart = true; }, loseDisk: () => { loseDisk = true; }, invalidate: () => { valid = false; }, openDisk: () => { diskOpened = true; }, prepared: () => { saved = fresh(); } };
}
for (const command of ["start", "resume"] as const) {
  it(`${command} admits renewed pending editor ownership only after native preflight`, async () => {
    const f = fixture(); command === "start" ? f.prepared() : f.recover();
    const buffer = f.lease.buffers[0]!; buffer.sessionId = crypto.randomUUID(); buffer.revision = crypto.randomUUID();
    f.admit(state => ({ ...state, files: state.files.map(file => file.target.kind === "editor"
      ? { ...file, target: { ...file.target, sessionId: buffer.sessionId, revision: buffer.revision } } : file) }));
    const result = await f.app[command](f.scope, f.undoId);
    expect(result.kind === "state" && result.state.status).toBe("applied");
    expect(f.actions()).toEqual(["read", command, "applyDisk"]);
    expect(f.editor.apply).toHaveBeenCalledExactlyOnceWith("main.tex");
    expect(f.lease.release).toHaveBeenCalledOnce();
  });
  it(`${command} refuses a changed revision in the same live owner`, async () => {
    const f = fixture(); command === "start" ? f.prepared() : f.recover();
    f.lease.buffers[0]!.revision = crypto.randomUUID();
    expect((await f.app[command](f.scope, f.undoId)).kind).toBe("unconfirmed");
    expect(f.actions()).toEqual(["read"]); expect(f.editor.apply).not.toHaveBeenCalled();
  });
}
it("a departed owner cannot resume an already acknowledged editor effect", async () => {
  const f = fixture(); f.partial(); f.lease.buffers[0]!.sessionId = crypto.randomUUID();
  expect((await f.app.resume(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.actions()).toEqual(["read"]); expect(f.editor.apply).not.toHaveBeenCalled();
});
it("uses checkpoint CAS to resume Pending work while preserving an acknowledged target", async () => {
  const f = fixture(); f.partial(); const buffer = f.lease.buffers[0]!;
  buffer.sessionId = crypto.randomUUID(); buffer.revision = crypto.randomUUID();
  f.lease.prepareUndoResume = vi.fn(async () => [{ path: buffer.path, revision: 2, stateVersion: 3 }]);
  expect(await f.app.resume(f.scope, f.undoId)).toMatchObject({ kind: "state", state: { status: "applied" } });
  expect(f.lease.prepareUndoResume).toHaveBeenCalledOnce();
  expect(f.actions()).toEqual(["read", "resume", "applyDisk"]);
  expect(f.editor.apply).not.toHaveBeenCalled();
});
it.each(["receipt", "session", "phase"])("refuses a Resume reply rewriting an acknowledged %s", async fault => {
  const f = fixture(); f.partial(); const buffer = f.lease.buffers[0]!;
  buffer.sessionId = crypto.randomUUID(); buffer.revision = crypto.randomUUID();
  f.lease.prepareUndoResume = async () => [{ path: buffer.path, revision: 2, stateVersion: 3 }];
  f.admit(state => ({ ...state, files: state.files.map(file => file.target.kind !== "editor" ? file
    : fault === "phase" ? { ...file, phase: "pending", target: { ...file.target, resultRevision: null } }
    : { ...file, target: { ...file.target, ...(fault === "session" ? { sessionId: buffer.sessionId } : { resultRevision: crypto.randomUUID() }) } }) }));
  expect((await f.app.resume(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.editor.apply).not.toHaveBeenCalled(); expect(f.actions()).not.toContain("applyDisk");
});
it("does not admit Resume or dispatch when the current checkpoint flush fails", async () => {
  const f = fixture(); f.partial();
  f.lease.prepareUndoResume = async () => { throw new Error("checkpoint write uncertain"); };
  expect((await f.app.resume(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.actions()).toEqual(["read"]); expect(f.editor.apply).not.toHaveBeenCalled(); expect(f.lease.release).toHaveBeenCalledOnce();
});
for (const fault of ["scope", "membership", "kind", "revision", "phase"] as const) {
  it(`renewal refuses a native reply with changed ${fault} before dispatch`, async () => {
    const f = fixture(); f.prepared(); const buffer = f.lease.buffers[0]!;
    buffer.sessionId = crypto.randomUUID(); buffer.revision = crypto.randomUUID();
    f.admit(state => {
      const renewed: AgentApplicationState = { ...state, files: state.files.map(file => file.target.kind === "editor"
        ? { ...file, target: { ...file.target, sessionId: buffer.sessionId, revision: buffer.revision } } : file) };
      if (fault === "scope") return { ...renewed, scope: { ...renewed.scope, proposalId: crypto.randomUUID() } };
      const file = renewed.files[0]!;
      const altered = fault === "membership" ? { ...file, path: "foreign.tex" }
        : fault === "kind" ? { ...file, target: { kind: "disk" as const } }
        : fault === "phase" ? { ...file, phase: "dispatched" as const }
        : { ...file, target: { kind: "editor" as const, sessionId: buffer.sessionId, revision: crypto.randomUUID(), resultRevision: null } };
      return { ...renewed, files: [altered, renewed.files[1]!] };
    });
    expect((await f.app.start(f.scope, f.undoId)).kind).toBe("unconfirmed");
    expect(f.editor.apply).not.toHaveBeenCalled(); expect(f.actions()).not.toContain("applyDisk");
    expect(f.lease.release).toHaveBeenCalledOnce();
  });
}
it("explicit resume skips confirmed editor effects and retains the complete lease", async () => {
  const f = fixture(); f.partial();
  const result = await f.app.resume(f.scope, f.undoId);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.actions()).toEqual(["read", "resume", "applyDisk"]);
  expect(f.editor.apply).not.toHaveBeenCalled(); expect(f.lease.release).toHaveBeenCalledOnce();
});
it("resume refuses a changed acknowledged editor revision before native admission", async () => {
  const f = fixture(); f.partial(); f.lease.buffers[0]!.revision = crypto.randomUUID();
  expect((await f.app.resume(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.actions()).toEqual(["read"]); expect(f.editor.apply).not.toHaveBeenCalled();
  expect(f.lease.release).toHaveBeenCalledOnce();
});
it("reports completion when the last pending file precedes already confirmed files", async () => {
  const f = fixture(); f.partial("z.tex");
  const result = await f.app.resume(f.scope, f.undoId);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.actions()).toEqual(["read", "resume"]);
  expect(f.editor.apply).toHaveBeenCalledExactlyOnceWith("main.tex");
  expect(f.lease.refresh).toHaveBeenCalledOnce(); expect(f.lease.release).toHaveBeenCalledOnce();
});
it("executes a mixed plan under one lease and retries only read history", async () => {
  const f = fixture();
  const result = await f.app.apply(f.scope, f.undoId);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.actions()).toEqual(["read", "prepare", "start", "applyDisk"]);
  expect(f.editor.apply).toHaveBeenCalledWith("main.tex");
  expect(f.lease.refresh).toHaveBeenCalledOnce(); expect(f.lease.release).toHaveBeenCalledOnce();
  await f.app.apply(f.scope, f.undoId); expect(f.acquire).toHaveBeenCalledOnce(); expect(f.editor.apply).toHaveBeenCalledOnce();
});
it("only explicit start starts an existing prepared baseline", async () => {
  const f = fixture(); f.prepared();
  await f.app.apply(f.scope, f.undoId); expect(f.actions()).toEqual(["read"]); expect(f.acquire).not.toHaveBeenCalled();
  const result = await f.app.start(f.scope, f.undoId);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.actions()).not.toContain("prepare");
});
it("a lost start reply stops dispatch and does not resume on retry", async () => {
  const f = fixture(); f.loseStart();
  expect((await f.app.apply(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.actions()).toEqual(["read", "prepare", "start", "defer"]);
  expect(f.editor.apply).not.toHaveBeenCalled();
  await f.app.start(f.scope, f.undoId); expect(f.actions().filter(a => a === "start")).toHaveLength(1);
  expect(f.lease.release).toHaveBeenCalledOnce();
});
it("refuses a disk target with an open buffer before any dispatch", async () => {
  const f = fixture(); f.openDisk();
  expect((await f.app.apply(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.actions()).toEqual(["read", "prepare", "defer"]);
  expect(f.editor.apply).not.toHaveBeenCalled();
});
it("host invalidation after the first edit prevents later disk writes", async () => {
  const f = fixture(), apply = f.editor.apply.getMockImplementation()!;
  f.editor.apply.mockImplementation(async path => { const result = await apply(path); f.invalidate(); return result; });
  expect((await f.app.apply(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.actions()).not.toContain("applyDisk"); expect(f.actions().at(-1)).toBe("defer");
  expect(f.lease.release).toHaveBeenCalledOnce();
});
it("uncertain disk work is not replayed, and refresh failures still release", async () => {
  const f = fixture(); f.loseDisk(); f.lease.refresh.mockRejectedValue(new Error("refresh failed"));
  expect((await f.app.apply(f.scope, f.undoId)).kind).toBe("unconfirmed");
  expect(f.lease.release).toHaveBeenCalledOnce();
  await f.app.apply(f.scope, f.undoId); expect(f.actions().filter(a => a === "applyDisk")).toHaveLength(1);
});
