/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApplicationScope, AgentApplicationState, AgentEditorSessionPort, AgentEditorRestorationRequest, AgentWorkspaceBuffer } from "@research-assistant/core/agent";
import { parseManuscriptPath } from "@research-assistant/writing";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history,undo } from "@codemirror/commands";
import { writingEditorIdentity } from "../editor/editorSession";
import { createWritingEditorSessionPort } from "../editor/editorSessionPort";
import { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import type { WritingGateway } from "../gateway/writingGateway";
import { useWritingProposalApplication } from "./useWritingProposalApplication";
import type { WritingFileSaveQueue } from "../persistence/WritingFileSaveQueue";
import { WritingFileSessions } from "../editor/writingFileSessions";

const desktop = vi.hoisted(() => ({find:vi.fn(),execute:vi.fn(),restore:vi.fn(),undo:vi.fn(),undoRestore:vi.fn()}));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", () => ({agentApplicationGateway:desktop,agentEditorRestorationGateway:{execute:desktop.restore},agentUndoGateway:{execute:desktop.undo},getAgentUndoEditorRestorationGateway:()=>({execute:desktop.undoRestore})}));
describe.each([false, true])("production application with injected gateways=%s", (injected) => {
const native = injected ? {find:vi.fn(),execute:vi.fn(),restore:vi.fn(),undo:vi.fn(),undoRestore:vi.fn()} : desktop;
const agentGateways = injected ? { applications: native, restorations: { execute: native.restore },
  undos: { find: vi.fn(), execute: native.undo }, undoRestorations: () => ({ execute: native.undoRestore }) } : undefined;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  if (injected) for (const method of Object.values(desktop)) expect(method).not.toHaveBeenCalled();
});

async function setup(makePort?: (scope:AgentApplicationScope)=>AgentEditorSessionPort, fileOptions?: {
  readonly fileSaves: Pick<WritingFileSaveQueue, "save">;
  readonly readFileBuffers: (manuscriptId: string) => readonly AgentWorkspaceBuffer[];
}) {
  const scope: AgentApplicationScope = {conversationId:crypto.randomUUID(),manuscriptId:crypto.randomUUID(),proposalId:crypto.randomUUID(),operationId:crypto.randomUUID()};
  const source = {listFiles:vi.fn(async () => []),listDirectories:vi.fn(async () => []),
    listCitationBindings:vi.fn(async () => []),getBibliographyStatus:vi.fn(async () => ({})),listManuscripts:vi.fn(async () => [])};
  const access = createExclusiveWritingGateway(source as unknown as WritingGateway);
  const port=makePort?.(scope);
  const resume = Object.assign(vi.fn(), {readSnapshot: () => port?{manuscriptId:scope.manuscriptId,relativePath:"open.tex",content:port.read()!.text,contentHash:"a".repeat(64),saveState:"dirty" as const}:undefined});
  const persistence = Object.assign(vi.fn(async () => true), {pause:vi.fn(async () => resume), syncEditorSnapshot:vi.fn(() => true)});
  const editor = {apply:vi.fn(),recover:vi.fn()};
  const publishMetadata = vi.fn(() => {expect(access.isExclusive()).toBe(false); expect(resume).not.toHaveBeenCalled();});
  const onBusyChange = vi.fn();
  let ready = true;
  let application: ReturnType<typeof useWritingProposalApplication> | undefined;
  function Host() {
    application = useWritingProposalApplication({access,persistence,editor,publishMetadata,onBusyChange,
      ...fileOptions,
      ...(agentGateways ? { agentGateways } : {}),
      readHost: () => ({manuscriptId:scope.manuscriptId,activePath:port?"open.tex":undefined,port:port??null,ready})});
    return null;
  }
  await act(async () => root.render(<Host />));
  if (!application) throw new Error("Host not mounted");
  native.find.mockResolvedValue(null);
  native.execute.mockResolvedValue({kind:"state",schemaVersion:1,scope,status:"applied",files:[]});
  return {application,scope,access,persistence,resume,publishMetadata,onBusyChange,source,editor,port, setReady: (value: boolean) => { ready = value; }};
}

it.each(["unready", "unmounted"])("does not save a terminal Undo after its file host becomes %s", async mode => {
  const fileSaves = { save: vi.fn() }, f = await setup(undefined, { fileSaves, readFileBuffers: () => [] });
  const undoId = crypto.randomUUID();
  const result = { schemaVersion: 1, originalScope: f.scope, undoId, result: {
    kind: "state", schemaVersion: 1, scope: { ...f.scope, operationId: undoId }, status: "applied",
    files: [{ path: "background.tex", phase: "acknowledged", target: { kind: "editor", sessionId: crypto.randomUUID(),
      revision: crypto.randomUUID(), resultRevision: crypto.randomUUID() } }],
  } };
  let finish!: (value: typeof result) => void;
  native.undo.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.application.undo(f.scope, undoId);
  await vi.waitFor(() => expect(native.undo).toHaveBeenCalledOnce());
  if (mode === "unmounted") await act(async () => root.unmount());
  else f.setReady(false);
  finish(result);
  expect(await pending).toMatchObject({ kind: "unconfirmed", state: { status: "applied" } });
  expect(fileSaves.save).not.toHaveBeenCalled();
});

it("holds workspace ownership through metadata refresh and releases saving last", async () => {
  const f = await setup();
  let finish!: () => void;
  f.source.listFiles.mockImplementationOnce(() => new Promise(resolve => {finish=() => resolve([]);}));
  const pending = f.application.accept(f.scope);
  await vi.waitFor(() => expect(f.source.listFiles).toHaveBeenCalled());
  expect(f.access.isExclusive()).toBe(true);
  expect(f.onBusyChange).toHaveBeenLastCalledWith(true);
  expect(await f.application.accept(f.scope)).toEqual({kind:"busy"});
  expect(await f.application.recover(f.scope,"main.tex")).toEqual({kind:"busy"});
  expect(f.publishMetadata).not.toHaveBeenCalled();
  finish();
  expect((await pending).kind).toBe("state");
  expect(f.publishMetadata).toHaveBeenCalledTimes(1);
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.access.isExclusive()).toBe(false);
  expect(f.onBusyChange).toHaveBeenLastCalledWith(false);
});

it.each([false, true])("flushes all file-owned editor targets before reporting application success (failure=%s)", async (failed) => {
  const files = new WritingFileSessions();
  const save = vi.fn<WritingFileSaveQueue["save"]>().mockImplementation(async (identity) => {
    if (failed && identity.relativePath === "second.tex") throw new Error("save failed");
    return { relativePath: parseManuscriptPath(identity.relativePath), content: "after", sha256: "c".repeat(64) };
  });
  const host = await setup((scope) => {
    const active = files.open({ manuscriptId: scope.manuscriptId, relativePath: "open.tex" }, "before", "a".repeat(64));
    files.open({ manuscriptId: scope.manuscriptId, relativePath: "second.tex" }, "other before", "b".repeat(64));
    return active.applicationPort;
  }, { fileSaves: { save }, readFileBuffers: (manuscriptId) => files.readBuffers(manuscriptId) });
  const buffers = files.readBuffers(host.scope.manuscriptId);
  const prepared = { kind: "state" as const, schemaVersion: 1 as const, scope: host.scope, status: "prepared" as const,
    files: buffers.map((buffer) => ({ path: buffer.path, phase: "pending" as const,
      target: { kind: "editor" as const, sessionId: buffer.sessionId, revision: buffer.revision, resultRevision: null } })) };
  let current: AgentApplicationState = prepared;
  native.execute.mockResolvedValueOnce(prepared);
  host.editor.apply.mockImplementation(async (scope, path) => {
    const session = files.get({ manuscriptId: scope.manuscriptId, relativePath: path })!;
    session.applicationPort.apply({ operationId: scope.operationId, expected: session.applicationPort.read()!, text: "after" });
    current = { ...current, status: path === "second.tex" ? "applied" : "applying",
      files: current.files.map((file) => file.path === path && file.target.kind === "editor"
        ? { ...file, phase: "acknowledged", target: { ...file.target, resultRevision: session.applicationPort.read()!.revision } } : file) };
    // The mock gateway returns each complete native plan, never just the selected file.
    return { kind: "state", state: current };
  });
  const result = await host.application.accept(host.scope);
  expect(result.kind).toBe(failed ? "unconfirmed" : "state");
  expect(native.execute.mock.calls[0]?.[0].buffers).toEqual(buffers);
  expect(save.mock.calls.map(([identity]) => identity)).toEqual([
    { manuscriptId: host.scope.manuscriptId, relativePath: "open.tex" },
    { manuscriptId: host.scope.manuscriptId, relativePath: "second.tex" },
  ]);
  expect(host.persistence).not.toHaveBeenCalled();
  expect(host.persistence.syncEditorSnapshot).not.toHaveBeenCalled();
});

it("drops metadata after unmount and rejects calls on the disposed host", async () => {
  const f = await setup();
  let finish!: () => void;
  f.source.listFiles.mockImplementationOnce(() => new Promise(resolve => {finish=() => resolve([]);}));
  const pending = f.application.accept(f.scope);
  await vi.waitFor(() => expect(f.source.listFiles).toHaveBeenCalled());
  await act(async () => root.render(null));
  finish(); await pending;
  expect(f.publishMetadata).not.toHaveBeenCalled();
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.access.isExclusive()).toBe(false);
  expect(await f.application.accept(f.scope)).toEqual({kind:"unavailable"});
});

it("keeps failed metadata refresh unconfirmed and still releases both boundaries", async () => {
  const f = await setup();
  f.source.listFiles.mockRejectedValueOnce(new Error("disk unavailable"));
  expect((await f.application.accept(f.scope)).kind).toBe("unconfirmed");
  expect(f.publishMetadata).not.toHaveBeenCalled();
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.access.isExclusive()).toBe(false);
  expect(f.onBusyChange).toHaveBeenLastCalledWith(false);
});

it("flushes an accepted editor proposal to the active source file before reporting success", async () => {
  const view = new EditorView({state: EditorState.create({doc: "before", extensions: [writingEditorIdentity, history()]})});
  try {
    const f = await setup(scope => createWritingEditorSessionPort(view, `${scope.manuscriptId}:open.tex`));
    const baseline = f.port!.read()!;
    const prepared = {kind:"state" as const, schemaVersion:1, scope:f.scope, status:"prepared" as const,
      files:[{path:"open.tex", phase:"pending" as const, target:{kind:"editor" as const, sessionId:baseline.sessionId, revision:baseline.revision}}]};
    const applied = {...prepared, status:"applied" as const, files:[{...prepared.files[0], phase:"acknowledged" as const}]};
    native.execute.mockResolvedValueOnce(prepared);
    f.editor.apply.mockImplementation(async (scope, path) => {
      const current = f.port!.read()!;
      f.port!.apply({operationId:scope.operationId, expected:current, text:"after"});
      expect(path).toBe("open.tex");
      return {kind:"state", state:applied};
    });
    expect(await f.application.accept(f.scope)).toEqual({kind:"state", state:applied});
    expect(f.persistence.syncEditorSnapshot).toHaveBeenCalledWith({manuscriptId:f.scope.manuscriptId, relativePath:"open.tex", content:"after"});
    expect(f.persistence).toHaveBeenCalledOnce();
  } finally { view.destroy(); }
});

it("keeps an accepted editor proposal unconfirmed when the explicit source flush fails", async () => {
  const view = new EditorView({state: EditorState.create({doc: "before", extensions: [writingEditorIdentity, history()]})});
  try {
    const f = await setup(scope => createWritingEditorSessionPort(view, `${scope.manuscriptId}:open.tex`));
    const baseline = f.port!.read()!;
    const prepared = {kind:"state" as const, schemaVersion:1, scope:f.scope, status:"prepared" as const,
      files:[{path:"open.tex", phase:"pending" as const, target:{kind:"editor" as const, sessionId:baseline.sessionId, revision:baseline.revision}}]};
    const applied = {...prepared, status:"applied" as const, files:[{...prepared.files[0], phase:"acknowledged" as const}]};
    native.execute.mockResolvedValueOnce(prepared);
    f.editor.apply.mockImplementation(async (scope) => {
      const current = f.port!.read()!;
      f.port!.apply({operationId:scope.operationId, expected:current, text:"after"});
      return {kind:"state", state:applied};
    });
    f.persistence.mockResolvedValueOnce(false);
    const result = await f.application.accept(f.scope);
    expect(result).toEqual({kind:"unconfirmed", state:applied});
  } finally { view.destroy(); }
});

it("reconciles through the mounted workspace with metadata publication before saving resumes", async () => {
  const f = await setup();
  native.execute.mockReset()
    .mockResolvedValueOnce({kind:"state",schemaVersion:1,scope:f.scope,status:"recoveryRequired",files:[{path:"main.tex",phase:"dispatched",target:{kind:"disk"}}]})
    .mockResolvedValueOnce({kind:"state",schemaVersion:1,scope:f.scope,status:"applied",files:[{path:"main.tex",phase:"acknowledged",target:{kind:"disk"}}]});
  expect((await f.application.recover(f.scope,"main.tex")).kind).toBe("state");
  expect(native.execute.mock.calls.map(call => call[0].action)).toEqual(["read","reconcileDisk"]);
  expect(f.publishMetadata).toHaveBeenCalledTimes(1);
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.access.isExclusive()).toBe(false);
  expect(f.onBusyChange).toHaveBeenLastCalledWith(false);
});

it("rolls back through the mounted workspace and retains exclusive ownership until refreshed", async () => {
  const f = await setup();
  native.execute.mockReset()
    .mockResolvedValueOnce({kind:"state",schemaVersion:1,scope:f.scope,status:"recoveryRequired",files:[{path:"main.tex",phase:"dispatched",target:{kind:"disk"}}]})
    .mockResolvedValueOnce({kind:"state",schemaVersion:1,scope:f.scope,status:"rolledBack",files:[{path:"main.tex",phase:"restored",target:{kind:"disk"}}]});
  expect((await f.application.rollback(f.scope)).kind).toBe("state");
  expect(native.execute.mock.calls.map(call => call[0].action)).toEqual(["read","rollbackDisk"]);
  expect(f.publishMetadata).toHaveBeenCalledTimes(1); expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.onBusyChange).toHaveBeenLastCalledWith(false);
});
it.each([false,true])("mounts editor restoration under the save lease and rejects unmount (%s)",async(detach)=>{
  const view=new EditorView({state:EditorState.create({doc:"before",extensions:[writingEditorIdentity,history()]})});
  let original!:ReturnType<AgentEditorSessionPort["read"]>;
  let applied!:NonNullable<ReturnType<AgentEditorSessionPort["read"]>>;
  try {
    const f=await setup(scope=>{
      const port=createWritingEditorSessionPort(view,`${scope.manuscriptId}:open.tex`);
      original=port.read()!;port.apply({operationId:scope.operationId,expected:original,text:"after"});applied=port.read()!;
      return port;
    });
    const state={kind:"state",schemaVersion:1,scope:f.scope,status:"recoveryRequired",files:[{path:"open.tex",phase:"acknowledged",target:{kind:"editor",sessionId:applied.sessionId,revision:original!.revision,resultRevision:applied.revision}},{path:"disk.tex",phase:"dispatched",target:{kind:"disk"}}]};
    const partial={...state,files:[{...state.files[0],phase:"restored"},state.files[1]]};
    const complete={...partial,status:"rolledBack",files:partial.files.map(file=>({...file,phase:"restored"}))};
    native.execute.mockImplementation(async(request)=>{
      expect(f.access.isExclusive()).toBe(true);expect(f.resume).not.toHaveBeenCalled();
      if(request.action==="read")return state;
      if(request.action==="prepareRollback") {expect(view.state.doc.toString()).toBe("after");return state;}
      expect(request.action).toBe("rollbackRemainder");expect(view.state.doc.toString()).toBe("before");return complete;
    });
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    native.restore.mockImplementation(async(request:AgentEditorRestorationRequest)=>{
      expect(f.access.isExclusive()).toBe(true);expect(f.resume).not.toHaveBeenCalled();
      if(request.action==="read")return {kind:"state",schemaVersion:1,application:state,path:"open.tex",restoration:null};
      if(request.action==="prepare") {
        if(detach)await gate;
        return {kind:"edit",schemaVersion:1,scope:f.scope,restoreId:request.restoreId,expected:request.current,text:"before"};
      }
      expect(request.actual.text).toBe("before");return {kind:"state",schemaVersion:1,application:partial,path:"open.tex",restoration:{id:request.restoreId,sessionId:applied.sessionId,expectedRevision:applied.revision,resultRevision:request.actual.revision}};
    });
    const pending=f.application.rollback(f.scope);
    if(detach) {
      await vi.waitFor(()=>expect(native.restore.mock.calls.some(([r])=>r.action==="prepare")).toBe(true));
      await act(async()=>root.unmount());release();
      expect((await pending).kind).toBe("unconfirmed");
      expect(view.state.doc.toString()).toBe("after");expect(f.publishMetadata).not.toHaveBeenCalled();
      expect(f.resume).toHaveBeenCalledTimes(1);expect(native.execute).toHaveBeenCalledTimes(2);
      return;
    }
    expect((await pending).kind).toBe("state");
    expect(native.restore.mock.calls.map(([r])=>r.action)).toEqual(["read","read","prepare","confirm"]);
    expect(f.resume).toHaveBeenCalledTimes(1);expect(f.publishMetadata).toHaveBeenCalledTimes(1);
    expect(undo(view)).toBe(true);expect(view.state.doc.toString()).toBe("after");
  } finally {view.destroy();}
});

it("holds undo, apply and recovery under the same mounted workspace exclusion", async () => {
  const f = await setup(), undoId = crypto.randomUUID();
  const state = (status: "prepared" | "applying" | "applied") => ({ schemaVersion: 1, originalScope: f.scope, undoId, result: {
    kind: "state", schemaVersion: 1, scope: { ...f.scope, operationId: undoId }, status,
    files: [{ path: "main.tex", phase: status === "applied" ? "acknowledged" : "pending", target: { kind: "disk" } }],
  } });
  native.undo.mockResolvedValueOnce({ schemaVersion: 1, originalScope: f.scope, undoId, result: null })
    .mockResolvedValueOnce(state("prepared")).mockResolvedValueOnce(state("applying")).mockResolvedValueOnce(state("applied"));
  let finish!: () => void;
  f.source.listFiles.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); }));
  const pending = f.application.undo(f.scope, undoId);
  await vi.waitFor(() => expect(f.source.listFiles).toHaveBeenCalled());
  expect(f.access.isExclusive()).toBe(true); expect(f.resume).not.toHaveBeenCalled();
  expect(await f.application.accept(f.scope)).toEqual({ kind: "busy" });
  expect(await f.application.startUndo(f.scope, undoId)).toEqual({ kind: "busy" });
  expect(await f.application.resumeUndo(f.scope, undoId)).toEqual({ kind: "busy" });
  expect(await f.application.rollbackUndo(f.scope, undoId)).toEqual({ kind: "busy" });
  expect(await f.application.recoverUndo(f.scope, undoId, "main.tex")).toEqual({ kind: "busy" });
  expect(await f.application.cancelUndo(f.scope, undoId)).toEqual({ kind: "busy" });
  finish(); expect((await pending).kind).toBe("state");
  expect(f.publishMetadata).toHaveBeenCalledOnce(); expect(f.resume).toHaveBeenCalledOnce();
  expect(native.undo.mock.calls.map(([r]) => r.command.action)).toEqual(["read", "prepare", "start", "applyDisk"]);
});

it("undo recovery refreshes metadata and cancellation never writes source", async () => {
  const f = await setup(), undoId = crypto.randomUUID();
  const response = (status: string, phase: string) => ({ schemaVersion: 1, originalScope: f.scope, undoId, result: {
    kind: "state", schemaVersion: 1, scope: { ...f.scope, operationId: undoId }, status,
    files: [{ path: "main.tex", phase, target: { kind: "disk" } }],
  } });
  native.undo.mockResolvedValueOnce(response("recoveryRequired", "dispatched"))
    .mockResolvedValueOnce(response("applied", "acknowledged"));
  expect((await f.application.recoverUndo(f.scope, undoId, "main.tex")).kind).toBe("state");
  expect(native.undo.mock.calls.map(([r]) => r.command.action)).toEqual(["read", "reconcileDisk"]);
  expect(f.resume).toHaveBeenCalledOnce(); expect(f.publishMetadata).toHaveBeenCalledOnce();
  native.undo.mockResolvedValue(response("rolledBack", "pending"));
  expect((await f.application.cancelUndo(f.scope, undoId)).kind).toBe("state");
  expect(f.persistence.pause).toHaveBeenCalledOnce();
});

it("unmount during undo preparation stops dispatch and releases both locks", async () => {
  const f = await setup(), undoId = crypto.randomUUID();
  const prepared = { schemaVersion: 1, originalScope: f.scope, undoId, result: {
    kind: "state", schemaVersion: 1, scope: { ...f.scope, operationId: undoId }, status: "prepared",
    files: [{ path: "main.tex", phase: "pending", target: { kind: "disk" } }],
  } };
  let finish!: () => void;
  native.undo.mockResolvedValueOnce({ ...prepared, result: null }).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(prepared); })).mockResolvedValue(prepared);
  const pending = f.application.undo(f.scope, undoId);
  await vi.waitFor(() => expect(native.undo).toHaveBeenCalledTimes(2));
  await act(async () => root.render(null)); finish();
  expect((await pending).kind).toBe("unconfirmed");
  expect(native.undo.mock.calls.map(([r]) => r.command.action)).toEqual(["read", "prepare", "defer"]);
  expect(f.publishMetadata).not.toHaveBeenCalled(); expect(f.resume).toHaveBeenCalledOnce();
  expect(f.access.isExclusive()).toBe(false);
  expect(await f.application.undo(f.scope, undoId)).toEqual({ kind: "unavailable" });
});

it("rolls back mixed undo with current editor bytes under one workspace lease", async () => {
  const undoId=crypto.randomUUID();
  const view=new EditorView({state:EditorState.create({doc:"accepted",extensions:[writingEditorIdentity,history()]})});
  try {
    let port!:AgentEditorSessionPort;
    const f=await setup(scope=>{
      port=createWritingEditorSessionPort(view,`${scope.manuscriptId}:open.tex`);
      port.apply({operationId:undoId,expected:port.read()!,text:"undone"});
      return port;
    });
    const baseline=port.read()!, undoScope={...f.scope,operationId:undoId};
    const state={kind:"state",schemaVersion:1,scope:undoScope,status:"recoveryRequired",files:[
      {path:"open.tex",phase:"acknowledged",target:{kind:"editor",sessionId:baseline.sessionId,revision:crypto.randomUUID(),resultRevision:baseline.revision}},
      {path:"disk.tex",phase:"acknowledged",target:{kind:"disk"}},
    ]};
    let gated=false, confirmed=false;
    const partial=()=>({...state,files:[{...state.files[0],phase:confirmed?"restored":"acknowledged"},state.files[1]]});
    native.undo.mockImplementation(async(request)=>{
      if(request.command.action!=="read") {expect(f.access.isExclusive()).toBe(true);expect(f.resume).not.toHaveBeenCalled();}
      if(request.command.action==="prepareRollback") {
        expect(request.command.buffers[0].text).toBe("undone");gated=true;
      }
      if(request.command.action==="rollbackDisk") {
        expect(confirmed).toBe(true);
        expect(request.command.buffers[0]).toMatchObject({text:"accepted",revision:port.read()!.revision,expectedDiskSha256:"a".repeat(64)});
        expect(request.command.buffers[0].revision).not.toBe(baseline.revision);
        return {result:{...partial(),status:"rolledBack",files:partial().files.map(file=>({...file,phase:"restored"}))}};
      }
      return {result:partial()};
    });
    native.undoRestore.mockImplementation(async(request:AgentEditorRestorationRequest)=>{
      expect(f.access.isExclusive()).toBe(true);expect(f.resume).not.toHaveBeenCalled();
      expect(request.scope).toEqual(undoScope);
      if(request.action==="read")return {kind:"state",schemaVersion:1,application:partial(),path:"open.tex",restoration:null};
      if(request.action==="prepare") {
        expect(gated).toBe(true);
        return {kind:"edit",schemaVersion:1,scope:undoScope,restoreId:request.restoreId,expected:request.current,text:"accepted"};
      }
      confirmed=true;
      return {kind:"state",schemaVersion:1,application:partial(),path:"open.tex",restoration:{id:request.restoreId,sessionId:baseline.sessionId,expectedRevision:baseline.revision,resultRevision:request.actual.revision}};
    });
    const result=await f.application.rollbackUndo(f.scope,undoId);
    expect(result.kind==="state" && result.state.status).toBe("rolledBack");
    expect(native.undo.mock.calls.map(([r])=>r.command.action)).toEqual(["read","prepareRollback","rollbackDisk"]);
    expect(f.publishMetadata).toHaveBeenCalledOnce();expect(f.resume).toHaveBeenCalledOnce();
    expect(undo(view)).toBe(true);expect(view.state.doc.toString()).toBe("undone");
    expect(undo(view)).toBe(true);expect(view.state.doc.toString()).toBe("accepted");
  } finally {view.destroy();}
});
});
