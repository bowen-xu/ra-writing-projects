/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {WritingAgentActivityGroup} from "../../../../../../apps/web/src/core/features/agent/presentation/WritingAgentActivity";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
it("keeps live work in the first line and completed calls in the bounded history, preserving manual disclosure",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 const items=[{type:"tool-call" as const,callId:"a",name:"research_exec_command",content:'{"cmd":"cat done.md"}',streaming:false},
 {type:"tool-result" as const,callId:"a",name:"research_exec_command",content:"done"},
 {type:"tool-call" as const,callId:"b",name:"research_apply_patch",content:'{"path":"current.md"}',streaming:true}];
 try{
  await act(async()=>root.render(<WritingAgentActivityGroup items={items}/>));
  const group=host.querySelector<HTMLDetailsElement>("[data-agent-activity-group]")!;
  expect(group.open).toBe(false);
  const title=group.querySelector(":scope > summary .writing-agent-activity-title")!;
  expect(title.textContent).toBe("应用修改 · current.md");
  expect(title.getAttribute("data-shimmer-active")).toBe("true");
  const rows=host.querySelectorAll<HTMLDetailsElement>(".tool-history-row");
  expect(rows).toHaveLength(1);expect(rows[0]?.textContent).toContain("done.md");
  expect(host.querySelector(".writing-agent-activity-group-body")?.textContent).not.toContain("current.md");
  await act(async()=>{group.open=true;group.dispatchEvent(new Event("toggle"));rows[0]!.open=true;});
  await act(async()=>root.render(<WritingAgentActivityGroup items={[...items,{type:"tool-result",callId:"b",name:"research_apply_patch",content:"failed",error:true}]}/>));
  expect(group.open).toBe(true);expect(rows[0]?.open).toBe(true);
  expect(title.textContent).toBe("编辑文件、运行命令");
  expect(title.getAttribute("data-shimmer-active")).toBe("false");
  expect(host.querySelector('[data-tool-status="success"] .tool-history-kind')).not.toBeNull();
  expect(host.querySelector('[data-tool-status="error"] .lucide-x')).not.toBeNull();
 }finally{await act(async()=>root.unmount());host.remove();}
});

it("retains tool history height while hidden and measures a resized chat on reveal",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const resizes:(()=>void)[]=[];
 vi.stubGlobal("ResizeObserver",class{constructor(run:()=>void){resizes.push(run);}observe(){}disconnect(){}});
 let visible=true,height=300;
 vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(()=>visible?new DOMRect(0,0,600,height):new DOMRect());
 vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockImplementation(()=>visible?height:0);
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 const items=[{type:"tool-call" as const,callId:"a",name:"read",content:'{"path":"a.md"}'},
 {type:"tool-call" as const,callId:"b",name:"read",content:'{"path":"b.md"}'}];
 const render=()=>root.render(<section className="writing-agent-messages" hidden={!visible}><WritingAgentActivityGroup items={items}/></section>);
 try{
  await act(async()=>render());
  const body=host.querySelector<HTMLElement>(".writing-agent-activity-group-body")!;
  expect(body.style.getPropertyValue("--tool-history-height")).toBe("180px");
  visible=false;
  await act(async()=>{render();resizes.forEach(run=>run());});
  expect(body.style.getPropertyValue("--tool-history-height")).toBe("180px");
  visible=true;height=400;
  await act(async()=>render());
  expect(body.style.getPropertyValue("--tool-history-height")).toBe("240px");
 }finally{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
