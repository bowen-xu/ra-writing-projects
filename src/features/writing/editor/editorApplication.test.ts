/** @vitest-environment happy-dom */
import { afterEach,expect,it,vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history,undo } from "@codemirror/commands";
import type { AgentApplicationRequest,AgentEditorSessionPort } from "@research-assistant/core/agent";
import { createAgentApplicationGateway } from "@research-assistant/data/agent";
import { writingEditorIdentity } from "./editorSession";
import { createWritingEditorSessionPort } from "./editorSessionPort";
import { createWritingEditorApplication } from "./editorApplication";
const views:EditorView[]=[];
afterEach(()=>{for(const v of views.splice(0))v.destroy();});
function fixture() {
  const scope={conversationId:crypto.randomUUID(),manuscriptId:crypto.randomUUID(),proposalId:crypto.randomUUID(),operationId:crypto.randomUUID()};
  const view=new EditorView({state:EditorState.create({doc:"before",extensions:[writingEditorIdentity,history()]})}); views.push(view);
  const port=createWritingEditorSessionPort(view,`${scope.manuscriptId}:main.tex`), baseline=port.read()!;
  let current:AgentEditorSessionPort|null=port, phase="pending",status="applying",revision:string|null=null;
  let beforeReply:(()=>Promise<void>)|null=null, loseAck=false;
  const state=()=>({kind:"state",schemaVersion:1,scope,status,files:[{path:"main.tex",phase,target:{kind:"editor",sessionId:baseline.sessionId,revision:baseline.revision,resultRevision:revision}}]});
  const invoke=vi.fn(async (_command:string,args:Record<string,unknown>)=>{
    const r=args.request as AgentApplicationRequest;
    if(r.action==="prepareEditor" && phase==="pending") {
      phase="dispatched";
      if(beforeReply)await beforeReply();
      return {kind:"edit",schemaVersion:1,scope,expected:r.current,text:"after 中文\r\n"};
    }
    if(r.action==="confirmEditor") {
      if(loseAck){loseAck=false;throw new Error("lost ACK");}
      phase="acknowledged";status="applied";revision=r.actual.revision;
    }
    if(r.action==="deferEditor")status="recoveryRequired";
    return state();
  });
  const app=createWritingEditorApplication(createAgentApplicationGateway(invoke),()=>current);
  return {scope,view,port,app,invoke,setPort:(p:AgentEditorSessionPort|null)=>{current=p;},
    delay:(p:Promise<void>)=>{beforeReply=()=>p;},loseAck:()=>{loseAck=true;}};
}
it("applies only the native command and confirms the actual CodeMirror receipt with undo intact",async()=>{
  const f=fixture();
  const result=await f.app.apply(f.scope,"main.tex");
  expect(result.kind==="state" && result.state.status).toBe("applied");
  expect(f.view.state.doc.toString()).toBe("after 中文\r\n");
  expect(undo(f.view)).toBe(true);expect(f.view.state.doc.toString()).toBe("before");
  const apply=vi.spyOn(f.port,"apply");
  await f.app.recover(f.scope,"main.tex");
  expect(apply).not.toHaveBeenCalled();expect(f.view.state.doc.toString()).toBe("before");
});
it("recovers a lost confirmation from the historical receipt without replay after undo",async()=>{
  const f=fixture();f.loseAck();
  expect((await f.app.apply(f.scope,"main.tex")).kind).toBe("unconfirmed");
  expect(undo(f.view)).toBe(true);
  const apply=vi.spyOn(f.port,"apply");
  const result=await f.app.recover(f.scope,"main.tex");
  expect(result.kind==="state" && result.state.status).toBe("applied");
  expect(apply).not.toHaveBeenCalled();expect(f.view.state.doc.toString()).toBe("before");
});
it("reports a post-dispatch hook exception as uncertain and recovers without another transaction",async()=>{
  const f=fixture(), dispatch=f.view.dispatch.bind(f.view);
  const spy=vi.spyOn(f.view,"dispatch").mockImplementation((...args)=>{dispatch(...args);throw new Error("after dispatch");});
  expect((await f.app.apply(f.scope,"main.tex")).kind).toBe("unconfirmed");
  expect(f.view.state.doc.toString()).toBe("after 中文\r\n");
  spy.mockClear();
  const recovered=await f.app.recover(f.scope,"main.tex");
  expect(recovered.kind==="state" && recovered.state.status).toBe("applied");
  expect(spy).not.toHaveBeenCalled();
});
it("does not apply a late command after the host switches or disposes its port",async()=>{
  const f=fixture();let release!:()=>void;f.delay(new Promise<void>(resolve=>{release=resolve;}));
  const pending=f.app.apply(f.scope,"main.tex");
  expect((await f.app.apply(f.scope,"main.tex")).kind).toBe("busy");
  f.port.dispose();f.setPort(null);release();
  expect((await pending).kind).toBe("unconfirmed");
  expect(f.view.state.doc.toString()).toBe("before");
  expect((await f.app.recover(f.scope,"main.tex")).kind).toBe("unconfirmed");
  expect(f.invoke.mock.calls.filter(([,a])=>(a.request as AgentApplicationRequest).action==="confirmEditor")).toHaveLength(0);
});
it("defers if typing or IME invalidates the snapshot while native preparation is pending",async()=>{
  for(const composing of [false,true]) {
    const f=fixture();let release!:()=>void;f.delay(new Promise<void>(resolve=>{release=resolve;}));
    const pending=f.app.apply(f.scope,"main.tex");
    if(composing)vi.spyOn(f.view,"composing","get").mockReturnValue(true);
    else f.view.dispatch({changes:{from:0,insert:"typed "}});
    release();expect((await pending).kind).toBe("unconfirmed");
    expect(f.view.state.doc.toString()).toBe(composing?"before":"typed before");
  }
});
