// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {Manuscript} from "@research-assistant/writing";
import type {WritingGateway} from "@research-assistant/writing-projects-preview/index";
import {ManuscriptRowActions} from "@research-assistant/writing-projects-preview/manuscript-row-actions";
const notice=vi.hoisted(()=>({success:vi.fn(),error:vi.fn()}));
vi.mock("@research-assistant/workbench-preview/notifications",()=>({notify:notice}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
it("shows five commands, guards duplicate clicks and checks PDF availability on the selected row",async()=>{
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const item={id:"row-project",title:"Paper",status:"active"} as Manuscript;
  let finish!:(item:Manuscript)=>void;
  const duplicate=vi.fn(()=>new Promise<Manuscript>(resolve=>{finish=resolve;}));
  const gateway={supportsCompilation:true,duplicateManuscript:duplicate,getLatestPdfCompileRun:vi.fn(async()=>undefined)} as unknown as WritingGateway;
  const onDuplicated=vi.fn(),beforeAction=vi.fn(async()=>true),onDelete=vi.fn();
  const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node=>node.textContent?.includes(text))!;
  async function open(){await act(async()=>host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());}
  try {
    await act(async()=>root.render(<ManuscriptRowActions item={item} operations={{gateway,beforeAction,onDuplicated}} onStatusChange={vi.fn()} onDelete={onDelete}/>));
    await open();expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(5);
    await act(async()=>{button("复制").click();button("复制").click();});
    expect(duplicate).toHaveBeenCalledExactlyOnceWith("row-project");expect(beforeAction).toHaveBeenCalledWith(item);
    await act(async()=>finish({...item,id:"copy"}));expect(onDuplicated).toHaveBeenCalledWith({...item,id:"copy"});
    await open();await act(async()=>button("PDF").click());
    expect(gateway.getLatestPdfCompileRun).toHaveBeenCalledWith("row-project");
    expect(notice.error).toHaveBeenCalledWith(expect.stringContaining("writing_pdf_missing"));
    await open();await act(async()=>button("删除").click());expect(onDelete).toHaveBeenCalledOnce();
  }finally{await act(async()=>root.unmount());host.remove();}
});

it("uses the same five actions inline and returns the actual delete button for focus restoration",async()=>{
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const onStatusChange=vi.fn(),onDelete=vi.fn();
  const item={id:"row",title:"Paper",status:"archived"} as Manuscript;
  try {
    await act(async()=>root.render(<ManuscriptRowActions item={item} onStatusChange={onStatusChange} onDelete={onDelete}/>));
    const buttons=[...host.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    expect(buttons.map(button=>button.getAttribute("aria-label"))).toEqual(["复制稿件 Paper","下载 ZIP Paper","下载 PDF Paper","恢复归档 Paper","永久删除 Paper"]);
    await act(async()=>buttons[3]!.click());expect(onStatusChange).toHaveBeenCalledOnce();
    await act(async()=>buttons[4]!.click());expect(onDelete).toHaveBeenCalledWith(buttons[4]);
  }finally{await act(async()=>root.unmount());host.remove();}
});
