import { expect, it, vi } from "vitest";
import { createAgentUndoGateway } from "@research-assistant/data/agent";
import { rollbackWritingUndo } from "./writingUndoRollback";
function fixture() {
  const scope = {conversationId: crypto.randomUUID(), manuscriptId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID()}, undoId = crypto.randomUUID();
  const state = {kind: "state", schemaVersion: 1, scope: {...scope, operationId: undoId}, status: "recoveryRequired", files: [{path: "main.tex", phase: "acknowledged", target: {kind: "disk"}}]};
  const result = {schemaVersion: 1, originalScope: scope, undoId, result: state};
  const invoke = vi.fn().mockResolvedValueOnce(result).mockResolvedValue({...result, result: {...state, status: "rolledBack", files: [{...state.files[0], phase: "restored"}]}});
  const lease = {buffers: [], isCurrent: () => true, refresh: vi.fn(async () => {}), release: vi.fn()};
  const acquire = vi.fn(async () => lease);
  return {scope, undoId, state, result, invoke, lease, acquire, gateway: createAgentUndoGateway(invoke)};
}
it("holds the full lease until metadata refresh and sends a scoped rollback command", async () => {
  const f = fixture();
  f.lease.refresh.mockImplementation(async () => {expect(f.lease.release).not.toHaveBeenCalled();});
  const result = await rollbackWritingUndo(f.scope, f.undoId, f.gateway, f.acquire);
  expect(result.kind === "state" && result.state.status).toBe("rolledBack");
  expect(f.invoke.mock.calls[1]![1]).toEqual({request: {scope: f.scope, undoId: f.undoId, command: {action: "rollbackDisk", buffers: []}}});
  expect(f.lease.refresh).toHaveBeenCalledOnce(); expect(f.lease.release).toHaveBeenCalledOnce();
});
it("keeps a lost response unconfirmed and still refreshes and releases", async () => {
  const f = fixture(); f.invoke.mockReset().mockResolvedValueOnce(f.result).mockRejectedValue(new Error("lost"));
  expect((await rollbackWritingUndo(f.scope, f.undoId, f.gateway, f.acquire)).kind).toBe("unconfirmed");
  expect(f.lease.refresh).toHaveBeenCalledOnce(); expect(f.lease.release).toHaveBeenCalledOnce();
});
it("does not start disk compensation if checkpoint capture outlives the workspace", async () => {
  const f = fixture();
  let current = true;
  const acquire = async () => ({ ...f.lease, isCurrent: () => current,
    prepareUndoResume: async () => { current = false; return []; } });
  expect((await rollbackWritingUndo(f.scope, f.undoId, f.gateway, acquire)).kind).toBe("unconfirmed");
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.lease.release).toHaveBeenCalledOnce();
});
it("rejects editor plans before acquiring a file lease", async () => {
  const f = fixture();
  f.invoke.mockReset().mockResolvedValue({...f.result, result: {...f.state, files: [{path: "main.tex", phase: "acknowledged", target: {kind: "editor", sessionId: crypto.randomUUID(), revision: crypto.randomUUID(), resultRevision: crypto.randomUUID()}}]}});
  expect((await rollbackWritingUndo(f.scope, f.undoId, f.gateway, f.acquire)).kind).toBe("unavailable");
  expect(f.acquire).not.toHaveBeenCalled();
});
it("refuses an open disk target and leaves files untouched", async () => {
  const f = fixture();
  const acquire = vi.fn(async () => ({...f.lease, buffers: [{path: "main.tex", sessionId: crypto.randomUUID(), revision: crypto.randomUUID(), text: "user text", expectedDiskSha256: "a".repeat(64)}]}));
  expect((await rollbackWritingUndo(f.scope, f.undoId, f.gateway, acquire)).kind).toBe("unavailable");
  expect(f.invoke).toHaveBeenCalledOnce(); expect(f.lease.release).toHaveBeenCalledOnce();
});
it("reads completed rollback without reacquiring a lease or replaying effects", async () => {
  const f = fixture();
  f.invoke.mockReset().mockResolvedValue({...f.result, result: {...f.state, status: "rolledBack", files: [{...f.state.files[0], phase: "restored"}]}});
  const result = await rollbackWritingUndo(f.scope, f.undoId, f.gateway, f.acquire);
  expect(result.kind === "state" && result.state.status).toBe("rolledBack");
  expect(f.invoke).toHaveBeenCalledOnce(); expect(f.acquire).not.toHaveBeenCalled();
});

function mixedFixture() {
  const f=fixture();
  const editorTarget={kind:"editor" as const,sessionId:crypto.randomUUID(),revision:crypto.randomUUID(),resultRevision:crypto.randomUUID()};
  const state: import("@research-assistant/core/agent").AgentApplicationState={kind:"state",schemaVersion:1,scope:{...f.scope,operationId:f.undoId},status:"recoveryRequired",files:[
    {path:"open.tex",phase:"acknowledged",target:editorTarget},{path:"main.tex",phase:"acknowledged",target:{kind:"disk"}},
  ]};
  const partial={...state,files:state.files.map(file=>file.path==="open.tex"?{...file,phase:"restored" as const}:file)};
  let current=true;
  const buffer={path:"open.tex",sessionId:editorTarget.sessionId,revision:editorTarget.resultRevision,text:"undone",expectedDiskSha256:"a".repeat(64)};
  const acquire=vi.fn(async()=>({...f.lease,buffers:[buffer],readBuffers:()=>[buffer],isCurrent:()=>current}));
  const editor={recover:vi.fn(async()=>({kind:"state" as const,state})),restore:vi.fn(async()=>({kind:"state" as const,state:partial}))};
  f.invoke.mockReset().mockResolvedValue({...f.result,result:state});
  return {...f,state,partial,acquire,editor,invalidate:()=>{current=false;}};
}
it("does not restore an editor when the complete native preflight fails",async()=>{
  const f=mixedFixture();f.invoke.mockResolvedValueOnce({...f.result,result:f.state}).mockRejectedValue(new Error("changed disk"));
  expect((await rollbackWritingUndo(f.scope,f.undoId,f.gateway,f.acquire,f.editor)).kind).toBe("unconfirmed");
  expect(f.editor.restore).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.map(([,args])=>args.request.command.action)).toEqual(["read","prepareRollback"]);
  expect(f.lease.refresh).toHaveBeenCalledOnce();expect(f.lease.release).toHaveBeenCalledOnce();
});
it("stops on an unconfirmed historical restoration without replaying it",async()=>{
  const f=mixedFixture();const editor={...f.editor,recover:vi.fn(async()=>({kind:"unconfirmed" as const,state:f.state}))};
  expect((await rollbackWritingUndo(f.scope,f.undoId,f.gateway,f.acquire,editor)).kind).toBe("unconfirmed");
  expect(f.invoke).toHaveBeenCalledOnce();expect(editor.restore).not.toHaveBeenCalled();expect(f.lease.release).toHaveBeenCalledOnce();
});
it("does not start disk compensation after the editor host was replaced",async()=>{
  const f=mixedFixture();f.editor.restore.mockImplementation(async()=>{f.invalidate();return {kind:"state",state:f.partial};});
  expect((await rollbackWritingUndo(f.scope,f.undoId,f.gateway,f.acquire,f.editor)).kind).toBe("unconfirmed");
  expect(f.invoke.mock.calls.map(([,args])=>args.request.command.action)).toEqual(["read","prepareRollback"]);
  expect(f.lease.release).toHaveBeenCalledOnce();
});
