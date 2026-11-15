import { expect, it, vi } from "vitest";
import { createAgentApplicationGateway } from "@research-assistant/data/agent";
import type { AgentApplicationState, AgentWorkspaceBuffer } from "@research-assistant/core/agent";
import { rollbackWritingApplication } from "./writingApplicationRollback";
import type { EditorApplicationResult } from "../editor/editorApplication";
import type { WritingApplicationLease } from "./writingProposalApplication";

function fixture() {
  const scope={conversationId:crypto.randomUUID(),manuscriptId:crypto.randomUUID(),proposalId:crypto.randomUUID(),operationId:crypto.randomUUID()};
  const state:AgentApplicationState={kind:"state",schemaVersion:1,scope,status:"recoveryRequired",files:[{path:"main.tex",phase:"dispatched",target:{kind:"disk"}}]};
  const restored:AgentApplicationState={...state,status:"rolledBack",files:[{path:"main.tex",phase:"restored",target:{kind:"disk"}}]};
  const invoke=vi.fn().mockResolvedValueOnce(state).mockResolvedValue(restored);
  const lease={buffers:[] as AgentWorkspaceBuffer[],isCurrent:vi.fn(()=>true),refresh:vi.fn(async()=>{}),release:vi.fn()};
  return {scope,state,restored,invoke,lease,run:()=>rollbackWritingApplication(scope,createAgentApplicationGateway(invoke),async()=>lease)};
}
it("holds the lease through rollback and cache refresh",async()=>{
  const f=fixture(); let finish!:()=>void;
  f.lease.refresh.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.run(); await vi.waitFor(()=>expect(f.lease.refresh).toHaveBeenCalled());
  expect(f.lease.release).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.map(call=>call[1].request.action)).toEqual(["read","rollbackDisk"]);
  finish(); expect(await pending).toEqual({kind:"state",state:f.restored});
  expect(f.lease.release).toHaveBeenCalledTimes(1);
});
it("rejects editor plans, open targets, completed applications and lost host ownership",async()=>{
  for(const mode of ["editor","open","applied","stale"]) {
    const f=fixture();
    if(mode==="editor") f.invoke.mockReset().mockResolvedValue({...f.state,files:[{path:"main.tex",phase:"dispatched",target:{kind:"editor",sessionId:crypto.randomUUID(),revision:crypto.randomUUID(),resultRevision:null}}]});
    if(mode==="open") f.lease.buffers.push({path:"main.tex",text:"new draft",expectedDiskSha256:"a".repeat(64),sessionId:crypto.randomUUID(),revision:crypto.randomUUID()});
    if(mode==="applied") f.invoke.mockReset().mockResolvedValue({...f.restored,status:"applied",files:[{path:"main.tex",phase:"acknowledged",target:{kind:"disk"}}]});
    if(mode==="stale") f.lease.isCurrent.mockReturnValue(false);
    expect(await f.run()).toEqual({kind:"unavailable"}); expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.lease.release).toHaveBeenCalledTimes(1);
  }
});
it("reads durable partial progress after a failed rollback and does not retry it",async()=>{
  const f=fixture();
  const partial={...f.state,files:[{path:"main.tex",phase:"restored",target:{kind:"disk"}}]};
  f.invoke.mockReset().mockResolvedValueOnce(f.state).mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(partial);
  expect(await f.run()).toEqual({kind:"unconfirmed",state:partial});
  expect(f.invoke.mock.calls.map(call=>call[1].request.action)).toEqual(["read","rollbackDisk","read"]);
  expect(f.lease.release).toHaveBeenCalledTimes(1);
});
it("returns historical rollback without repeating it and reports refresh failure",async()=>{
  const f=fixture(); f.invoke.mockReset().mockResolvedValue(f.restored);
  f.lease.refresh.mockRejectedValueOnce(new Error("cache unavailable"));
  expect(await f.run()).toEqual({kind:"unconfirmed",state:f.restored});
  expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.lease.release).toHaveBeenCalledTimes(1);
});
function mixedFixture() {
  const f=fixture(),sessionId=crypto.randomUUID(),revision=crypto.randomUUID(),resultRevision=crypto.randomUUID();
  const state:AgentApplicationState={...f.state,files:[...f.state.files,{path:"open.tex",phase:"acknowledged",target:{kind:"editor",sessionId,revision,resultRevision}}]};
  const partial:AgentApplicationState={...state,files:state.files.map(file=>file.path==="open.tex"?{...file,phase:"restored"}:file)};
  const complete:AgentApplicationState={...partial,status:"rolledBack",files:partial.files.map(file=>({...file,phase:"restored"}))};
  f.invoke.mockReset().mockResolvedValueOnce(state).mockResolvedValueOnce(state).mockResolvedValue(complete);
  f.lease.buffers.push({path:"open.tex",sessionId,revision:resultRevision,text:"after",expectedDiskSha256:"a".repeat(64)});
  const editor={restore:vi.fn<()=>Promise<EditorApplicationResult>>(async()=>({kind:"state",state:partial})),recover:vi.fn<()=>Promise<EditorApplicationResult>>(async()=>({kind:"state",state}))};
  return {...f,state,partial,complete,editor,run:()=>rollbackWritingApplication(f.scope,createAgentApplicationGateway(f.invoke),async()=>f.lease,editor)};
}
it("restores editor effects before disk remainder under one lease",async()=>{
  const f=mixedFixture();
  f.editor.restore.mockImplementationOnce(async()=>{
    expect(f.lease.release).not.toHaveBeenCalled();expect(f.invoke).toHaveBeenCalledTimes(2);
    return {kind:"state",state:f.partial};
  });
  expect(await f.run()).toEqual({kind:"state",state:f.complete});
  expect(f.editor.restore).toHaveBeenCalledWith(f.scope,"open.tex",undefined);
  expect(f.invoke.mock.calls.map(call=>call[1].request.action)).toEqual(["read","prepareRollback","rollbackRemainder"]);
  expect(f.lease.refresh).toHaveBeenCalledTimes(1);expect(f.lease.release).toHaveBeenCalledTimes(1);
});
it("preflights every live editor and rejects an open disk before any compensation",async()=>{
  for(const mode of ["missing","wrong-session","open-disk"]) {
    const f=mixedFixture();
    if(mode==="missing")f.lease.buffers=[];
    else if(mode==="wrong-session")f.lease.buffers[0]={...f.lease.buffers[0]!,sessionId:crypto.randomUUID()};
    else f.lease.buffers.push({...f.lease.buffers[0]!,path:"main.tex"});
    expect(await f.run()).toEqual({kind:"unavailable"});expect(f.editor.restore).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledTimes(1);expect(f.lease.release).toHaveBeenCalledTimes(1);
  }
});
it("stops disk compensation if editor restoration is unconfirmed or ownership changes",async()=>{
  for(const mode of ["unconfirmed","stale"]) {
    const f=mixedFixture();
    if(mode==="unconfirmed")f.editor.restore.mockResolvedValueOnce({kind:"unconfirmed",state:f.partial});
    else f.editor.restore.mockImplementationOnce(async()=>{f.lease.isCurrent.mockReturnValue(false);return {kind:"state",state:f.partial};});
    expect(await f.run()).toEqual({kind:"unconfirmed",state:f.partial});
    expect(f.invoke).toHaveBeenCalledTimes(2);expect(f.lease.release).toHaveBeenCalledTimes(1);
  }
});
it("admits a rebuilt editor using fresh checkpoint CAS and rechecks all buffers before disk", async () => {
  const f = mixedFixture(), initial = structuredClone(f.lease.buffers);
  const buffers = initial.map(buffer => ({...buffer, sessionId: crypto.randomUUID(), revision: crypto.randomUUID()}));
  const proofs = [{path: "open.tex", revision: 3, stateVersion: 7}];
  const lease: WritingApplicationLease = {...f.lease, readBuffers: () => buffers, prepareUndoResume: vi.fn(async () => proofs)};
  f.editor.restore.mockImplementationOnce(async () => {
    buffers[0]!.text = "before"; buffers[0]!.revision = crypto.randomUUID(); proofs[0]!.stateVersion = 8;
    return {kind: "state", state: f.partial};
  });
  expect(await rollbackWritingApplication(f.scope, createAgentApplicationGateway(f.invoke), async () => lease, f.editor))
    .toEqual({kind: "state", state: f.complete});
  expect(f.editor.recover).toHaveBeenCalledExactlyOnceWith(f.scope, "open.tex");
  const requests = f.invoke.mock.calls.map(call => structuredClone(call[1].request));
  expect(requests[1]).toMatchObject({action: "prepareRollback", buffers: [{...buffers[0], text: "after", revision: expect.any(String)}],
    checkpointVersions: [{path: "open.tex", revision: 3, stateVersion: 7}]});
  expect(requests[2]).toEqual({action: "rollbackRemainder", scope: f.scope, buffers, checkpointVersions: proofs});
  expect(lease.prepareUndoResume).toHaveBeenCalledTimes(2);
  expect(f.lease.buffers).toEqual(initial);
});
it("preflights the entire batch before compensation and rejects changed frozen receipts", async () => {
  for (const fault of ["preflight", "changed receipt", "lost ownership"] as const) {
    const f = mixedFixture();
    if (fault === "preflight") f.invoke.mockReset().mockResolvedValueOnce(f.state).mockRejectedValueOnce(new Error("another file changed")).mockResolvedValue(f.state);
    if (fault === "changed receipt") f.invoke.mockReset().mockResolvedValueOnce(f.state).mockResolvedValue({...f.state,
      files: f.state.files.map(file => file.target.kind === "editor" ? {...file, target: {...file.target, resultRevision: crypto.randomUUID()}} : file)});
    if (fault === "lost ownership") f.editor.recover.mockImplementationOnce(async () => {
      f.lease.isCurrent.mockReturnValue(false); return {kind: "state", state: f.state};
    });
    expect(await f.run()).toMatchObject({kind: "unconfirmed"});
    expect(f.editor.restore).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.some(call => call[1].request.action === "rollbackRemainder")).toBe(false);
    expect(f.lease.release).toHaveBeenCalledOnce();
  }
});
