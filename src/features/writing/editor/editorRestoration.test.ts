/** @vitest-environment happy-dom */
import { afterEach,describe,expect,it,vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history,undo } from "@codemirror/commands";
import type { AgentEditorRestoration,AgentEditorRestorationRequest,AgentEditorSessionPort } from "@research-assistant/core/agent";
import { createAgentEditorRestorationGateway, createAgentUndoEditorRestorationGateway } from "@research-assistant/data/agent";
import { writingEditorIdentity } from "./editorSession";
import { createWritingEditorSessionPort } from "./editorSessionPort";
import { createWritingEditorRestoration } from "./editorRestoration";
import type { WritingEditorDelivery } from "./editorApplication";
const views:EditorView[]=[];
afterEach(()=>{for(const v of views.splice(0))v.destroy();});
describe.each([false, true])("restoration transport undo=%s", (asUndo) => {
function fixture(checkpointed = false) {
  const scope={conversationId:crypto.randomUUID(),manuscriptId:crypto.randomUUID(),proposalId:crypto.randomUUID(),operationId:crypto.randomUUID()};
  const view=new EditorView({state:EditorState.create({doc:Text.of(["before\r","中文"]),extensions:[writingEditorIdentity,history()]})});views.push(view);
  const port=createWritingEditorSessionPort(view,`${scope.manuscriptId}:main.tex`),before=port.read()!;
  port.apply({operationId:scope.operationId,expected:before,text:"after\r\n中文"});
  const applied=port.read()!;
  let current:AgentEditorSessionPort|null=port,restoration:AgentEditorRestoration|null=null,loseAck=false;
  let gate:Promise<void>|null=null;
  const state=()=>({kind:"state",schemaVersion:1,path:"main.tex",restoration,application:{kind:"state",schemaVersion:1,scope,status:restoration?.resultRevision?"rolledBack":"recoveryRequired",files:[{path:"main.tex",phase:restoration?.resultRevision?"restored":"acknowledged",target:{kind:"editor",sessionId:before.sessionId,revision:before.revision,resultRevision:applied.revision}}]}});
  const invoke=vi.fn(async (_command:string,args:Record<string,unknown>)=>{
    const r=args.request as AgentEditorRestorationRequest;
    if(r.action==="prepare" && !restoration) {
      if(r.current.revision!==applied.revision || r.current.text!==applied.text)throw new Error("conflict");
      restoration={id:r.restoreId,sessionId:applied.sessionId,expectedRevision:applied.revision,resultRevision:null};
      if(gate)await gate;
      return {kind:"edit",schemaVersion:1,scope,restoreId:r.restoreId,expected:r.current,text:before.text};
    }
    if(r.action==="confirm") {
      if(loseAck){loseAck=false;throw new Error("lost ACK");}
      restoration={...restoration!,resultRevision:r.actual.revision};
    }
    return state();
  });
  const originalScope={...scope,operationId:crypto.randomUUID()};
  const gateway=asUndo ? createAgentUndoEditorRestorationGateway(async(command,args)=>{
    expect(command).toBe("agent_writing_undo_editor_restoration");
    const envelope=args.request as {originalScope: typeof scope; request: AgentEditorRestorationRequest};
    expect(envelope.originalScope).toEqual(originalScope);
    return {originalScope,result:await invoke(command,{request:envelope.request})};
  }, originalScope) : createAgentEditorRestorationGateway(invoke);
  const delivery={apply:vi.fn<WritingEditorDelivery["apply"]>(async (_scope, _path, target, edit)=>target.apply(edit)),
    settle:vi.fn<WritingEditorDelivery["settle"]>(async()=>true)};
  const app=createWritingEditorRestoration(gateway,()=>current,checkpointed?delivery:undefined);
  return {scope,view,port,app,invoke,delivery,delay:(p:Promise<void>)=>{gate=p;},loseAck:()=>{loseAck=true;},detach:()=>{port.dispose();current=null;}};
}
it("does not confirm compensation until its actual restoration receipt is reliably checkpointed",async()=>{
  const f=fixture(true);f.delivery.settle.mockResolvedValue(false);
  expect((await f.app.restore(f.scope,"main.tex")).kind).toBe("unconfirmed");
  expect(f.invoke.mock.calls.some(([,args])=>(args.request as AgentEditorRestorationRequest).action==="confirm")).toBe(false);
  expect(f.view.state.doc.toString()).toBe("before\r\n中文");
  const delivered=f.delivery.apply.mock.calls[0]!,restoreId=delivered[3].operationId;
  expect(delivered[0]).toEqual({...f.scope,operationId:restoreId});
  f.view.dispatch({changes:{from:0,insert:"later "}});
  f.delivery.settle.mockResolvedValue(true);
  const result=await f.app.recover(f.scope,"main.tex");
  expect(result.kind==="state" && result.state.status).toBe("rolledBack");
  expect(f.delivery.apply).toHaveBeenCalledOnce();
  expect(f.delivery.settle).toHaveBeenLastCalledWith({...f.scope,operationId:restoreId},"main.tex",f.port);
  expect(f.view.state.doc.toString()).toBe("later before\r\n中文");
});
it("compensates as its own transaction and preserves original undo history",async()=>{
  const f=fixture();
  expect((await f.app.restore(f.scope,"main.tex")).kind).toBe("state");
  expect(f.view.state.doc.toString()).toBe("before\r\n中文");
  expect(undo(f.view)).toBe(true);expect(f.view.state.doc.toString()).toBe("after\r\n中文");
  expect(undo(f.view)).toBe(true);expect(f.view.state.doc.toString()).toBe("before\r\n中文");
  const apply=vi.spyOn(f.port,"apply");
  await f.app.restore(f.scope,"main.tex");expect(apply).not.toHaveBeenCalled();
});
it("recovers lost confirmation after later typing without replaying a restore",async()=>{
  const f=fixture();f.loseAck();
  expect((await f.app.restore(f.scope,"main.tex")).kind).toBe("unconfirmed");
  f.view.dispatch({changes:{from:0,insert:"later "}});
  const apply=vi.spyOn(f.port,"apply");
  const result=await f.app.recover(f.scope,"main.tex");
  expect(result.kind==="state" && result.state.status).toBe("rolledBack");
  expect(apply).not.toHaveBeenCalled();expect(f.view.state.doc.toString()).toBe("later before\r\n中文");
});
it("never begins a restore from recovery or after a port was detached",async()=>{
  const f=fixture();await f.app.recover(f.scope,"main.tex");
  expect(f.invoke.mock.calls.map(([,a])=>(a.request as AgentEditorRestorationRequest).action)).toEqual(["read"]);
  let release!:()=>void;f.delay(new Promise<void>(r=>{release=r;}));
  const pending=f.app.restore(f.scope,"main.tex");
  await vi.waitFor(()=>expect(f.invoke.mock.calls.some(([,a])=>(a.request as AgentEditorRestorationRequest).action==="prepare")).toBe(true));
  expect((await f.app.restore(f.scope,"main.tex")).kind).toBe("busy");
  f.detach();release();expect((await pending).kind).toBe("unconfirmed");
  expect(f.view.state.doc.toString()).toBe("after\r\n中文");
});
it.each([false,true])("refuses a prepared restore invalidated by typing or IME (%s)",async(composing)=>{
  const f=fixture();let release!:()=>void;f.delay(new Promise<void>(r=>{release=r;}));
  const pending=f.app.restore(f.scope,"main.tex");
  await vi.waitFor(()=>expect(f.invoke.mock.calls.some(([,a])=>(a.request as AgentEditorRestorationRequest).action==="prepare")).toBe(true));
  if(composing)vi.spyOn(f.view,"composing","get").mockReturnValue(true);
  else f.view.dispatch({changes:{from:0,insert:"typed "}});
  release();expect((await pending).kind).toBe("unconfirmed");
  expect(f.view.state.doc.toString()).toBe(composing?"after\r\n中文":"typed after\r\n中文");
  const apply=vi.spyOn(f.port,"apply");
  expect((await f.app.recover(f.scope,"main.tex")).kind).toBe("unconfirmed");
  expect(apply).not.toHaveBeenCalled();
});
it("recovers a post-dispatch exception using the restore receipt without another transaction",async()=>{
  const f=fixture(),dispatch=f.view.dispatch.bind(f.view);
  const spy=vi.spyOn(f.view,"dispatch").mockImplementation((...args)=>{dispatch(...args);throw new Error("after dispatch");});
  expect((await f.app.restore(f.scope,"main.tex")).kind).toBe("unconfirmed");
  expect(f.view.state.doc.toString()).toBe("before\r\n中文");
  spy.mockClear();
  const result=await f.app.recover(f.scope,"main.tex");
  expect(result.kind==="state" && result.state.status).toBe("rolledBack");
  expect(spy).not.toHaveBeenCalled();
});

});
