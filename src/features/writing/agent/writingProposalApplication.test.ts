import { expect, it, vi } from "vitest";
import type { AgentApplicationRequest, AgentApplicationState } from "@research-assistant/core/agent";
import { createAgentApplicationGateway } from "@research-assistant/data/agent";
import { createWritingProposalApplication } from "./writingProposalApplication";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const scope = {conversationId: id(1), manuscriptId: id(2), proposalId: id(3), operationId: id(4)};
  let state: AgentApplicationState = {kind: "state", schemaVersion: 1, scope, status: "prepared", files: [
    {path: "a.tex", phase: "pending", target: {kind: "disk"}},
    {path: "main.tex", phase: "pending", target: {kind: "editor", sessionId: id(5), revision: id(6), resultRevision: null}},
    {path: "z.tex", phase: "pending", target: {kind: "disk"}},
  ]};
  let existing: AgentApplicationState | null = null;
  let beginStatus: AgentApplicationState["status"] = "prepared";
  const order: string[] = [];
  function acknowledge(path: string) {
    state = {...state, files: state.files.map(file => file.path !== path ? file : {...file, phase: "acknowledged",
      target: file.target.kind === "disk" ? file.target : {...file.target, resultRevision: id(7)}})};
    state = {...state, status: state.files.every(file => file.phase === "acknowledged") ? "applied" : "applying"};
    return state;
  }
  const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "agent_find_writing_proposal_application") return existing;
    const request = args.request as AgentApplicationRequest;
    order.push(request.action === "applyDisk" ? request.path : request.action);
    if (request.action === "begin") return {...state, status: beginStatus};
    if (request.action === "resume") return {...state, status: "applying" as const};
    if (request.action === "applyDisk") acknowledge(request.path);
    return state;
  });
  const editor = {apply: vi.fn(async (_scope: unknown, path: string) => {
    order.push(path);
    return {kind: "state" as const, state: acknowledge(path)};
  })};
  const lease = {buffers: [{path: "main.tex", expectedDiskSha256: "a".repeat(64), sessionId: id(5), revision: id(6), text: "draft"}],
    isCurrent: vi.fn(() => true), refresh: vi.fn(async () => {order.push("refresh");}), release: vi.fn(() => {order.push("release");})};
  const acquire = vi.fn(async () => lease);
  const app = createWritingProposalApplication(createAgentApplicationGateway(invoke), editor, acquire);
  return {scope, app, invoke, editor, lease, acquire, order, state: () => state,
    existing: () => {existing = state;},
    existingApplying: () => {existing = {...state, status: "applying"};},
    existingRecovery: () => {existing = {...state, status: "recoveryRequired"};},
    existingDispatched: () => {existing = {...state, status: "applying", files: state.files.map((file, index) => index === 0 ? {...file, phase: "dispatched" as const} : file)};},
    beginAsApplying: () => {beginStatus = "applying";}};
}

it("preflights the full plan before ordered disk/editor dispatch and refreshes before release", async () => {
  const f = fixture();
  const result = await f.app.apply(f.scope);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.order).toEqual(["begin", "a.tex", "main.tex", "z.tex", "refresh", "release"]);
  expect(f.invoke.mock.calls[0]?.[1]).toEqual({request: {
    conversationId: f.scope.conversationId, manuscriptId: f.scope.manuscriptId, proposalId: f.scope.proposalId,
  }});
  expect(f.invoke.mock.calls[1]?.[1]).toEqual({request: {action: "begin", scope: f.scope, buffers: f.lease.buffers}});
});

it("continues dispatch when native admission already reports applying", async () => {
  const f = fixture(); f.beginAsApplying();
  const result = await f.app.apply(f.scope);
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.order).toEqual(["begin", "a.tex", "main.tex", "z.tex", "refresh", "release"]);
});

it("returns an existing partial operation without acquiring a lease or dispatching", async () => {
  const f = fixture(); f.existing();
  expect(await f.app.apply({...f.scope, operationId: id(9)})).toEqual({kind: "state", state: f.state()});
  expect(f.acquire).not.toHaveBeenCalled(); expect(f.editor.apply).not.toHaveBeenCalled();
  expect(f.order).toEqual([]);
});

it("resumes an existing applying operation only when every file is still pending", async () => {
  const f = fixture(); f.existingApplying();
  const result = await f.app.apply({...f.scope, operationId: id(9)});
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.acquire).toHaveBeenCalledExactlyOnceWith(f.scope);
  expect(f.editor).toBeDefined();
  expect(f.order).toEqual(["resume", "a.tex", "main.tex", "z.tex", "refresh", "release"]);
  expect(f.editor.apply).toHaveBeenCalledExactlyOnceWith(f.scope, "main.tex");
});

it("resumes a recovery-required operation through native admission before dispatch", async () => {
  const f = fixture(); f.existingRecovery();
  const result = await f.app.apply({...f.scope, operationId: id(9)});
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(f.order).toEqual(["resume", "a.tex", "main.tex", "z.tex", "refresh", "release"]);
});

it("never resumes an operation that already has a dispatched file", async () => {
  const f = fixture(); f.existingDispatched();
  const result = await f.app.apply({...f.scope, operationId: id(9)});
  expect(result.kind === "state" && result.state.files[0]?.phase).toBe("dispatched");
  expect(f.acquire).not.toHaveBeenCalled();
  expect(f.order).toEqual([]);
});

it("does not dispatch when admission is uncertain and only reads the original operation", async () => {
  const f = fixture();
  f.invoke.mockImplementationOnce(async () => null).mockImplementationOnce(async () => {throw new Error("lost begin");});
  expect((await f.app.apply(f.scope)).kind).toBe("unconfirmed");
  expect(f.order).toEqual(["read", "refresh", "release"]);
  expect(f.editor.apply).not.toHaveBeenCalled();
});

it("stops after an uncertain editor transaction without attempting later disk files", async () => {
  const f = fixture();
  f.editor.apply.mockRejectedValueOnce(new Error("lost editor result"));
  const result = await f.app.apply(f.scope);
  expect(result.kind).toBe("unconfirmed");
  expect(f.order).toEqual(["begin", "a.tex", "read", "refresh", "release"]);
  expect(f.state().files[2]?.phase).toBe("pending");
});

it("rejects incomplete editor coverage before any file side effect", async () => {
  const f = fixture(); f.lease.buffers.length = 0;
  expect((await f.app.apply(f.scope)).kind).toBe("unconfirmed");
  expect(f.order).toEqual(["begin", "refresh", "release"]);
});

it("does not continue after an editor reply changes the plan or operation identity", async () => {
  for (const foreign of [false, true]) {
    const f = fixture();
    f.editor.apply.mockResolvedValueOnce({kind: "state", state: {...f.state(),
      ...(foreign ? {scope: {...f.scope, operationId: id(9)}} : {files: f.state().files.slice(0, 2)})}});
    expect((await f.app.apply(f.scope)).kind).toBe("unconfirmed");
    expect(f.order).toEqual(["begin", "a.tex", "refresh", "release"]);
  }
});

it("stops when the workspace guard expires between files", async () => {
  const f = fixture();
  f.lease.isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
  expect((await f.app.apply(f.scope)).kind).toBe("unconfirmed");
  expect(f.order).toEqual(["begin", "a.tex", "refresh", "release"]);
});

it("keeps duplicate exclusion until cache refresh settles, including its failure", async () => {
  const f = fixture();
  let fail!: (reason: Error) => void;
  let entered!: () => void;
  const refreshing = new Promise<void>(resolve => {entered = resolve;});
  f.lease.refresh.mockImplementation(() => {entered(); return new Promise((_resolve, reject) => {fail = reject;});});
  const pending = f.app.apply(f.scope);
  await refreshing;
  expect(await f.app.apply(f.scope)).toEqual({kind: "busy"});
  expect(f.lease.release).not.toHaveBeenCalled();
  fail(new Error("cache unavailable"));
  const result = await pending;
  expect(result.kind).toBe("unconfirmed");
  expect("state" in result && result.state?.status).toBe("applied");
  expect(f.lease.release).toHaveBeenCalledTimes(1);
});
