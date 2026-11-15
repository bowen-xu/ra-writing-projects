import {withSourceNamespaces} from "../../../../../../apps/web/src/core/features/agent/sourceDirectoryFixtures";
/** @vitest-environment happy-dom */
import {act,type ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {ToolActivityHistoryRow} from "../../../../../../apps/web/src/core/features/agent/presentation/ToolActivityHistoryRow";
import {toolActivityRows} from "../../../../../../apps/web/src/core/features/agent/presentation/toolActivityModel";

const directory=vi.hoisted(()=>vi.fn());
vi.mock("../../../../../../apps/web/src/core/features/agent/sourceDirectory",()=>({sourceDirectory:directory}));
vi.mock("../../../../../../apps/web/src/core/components/ControlHint",()=>({ControlHint:({children,content}:{children:ReactNode;content:ReactNode})=><>{children}<aside>{content}</aside></>}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
const path="source://library/paper/portrait";
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.clearAllMocks();});
async function mount(status:string,name?:string,available=true){
 directory.mockReturnValue(withSourceNamespaces({value:{kind:"root"},child:async(id:string)=>available&&id==="paper"?{value:{kind:"paper"},child:async(child:string)=>child==="portrait"?{value:{kind:"structuredObject",resource:{title:"文献画像",revision:3}},child:async()=>undefined}:undefined}:undefined}));
 const patch=`*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+new\n*** End Patch`;
 const row=toolActivityRows([{type:"tool-call",callId:"edit",name:"research_apply_patch",content:JSON.stringify({patch})},{type:"tool-result",callId:"edit",name:"research_apply_patch",content:JSON.stringify({status,targets:[{path,...name?{name}:{},status:status==="completed"?"applied":"failed",message:status==="declined"?JSON.stringify({code:"edit_declined"}):"original failure"}]})}])[0]!;
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 cleanups.push(async()=>{await act(async()=>root.unmount());host.remove();});
 await act(async()=>root.render(<ToolActivityHistoryRow row={row}/>));return host;
}
it.each([["completed","已编辑"],["failed","无法编辑"],["declined","拒绝编辑"]])("resolves the %s resource name and reuses readable source hints",async(status,label)=>{
 const host=await mount(status!);
 const compact=host.querySelector(".tool-row-compact")!;
 expect(compact.querySelector(".tool-patch-file-name")?.textContent).toBe("文献画像");
 expect(compact.textContent).toContain(`${label} 文献画像`);expect(compact.textContent).not.toContain("source://");
 const hint=compact.querySelector(".agent-source-hint")!;
 expect(hint.textContent).toBe("文献画像v3");expect(hint.textContent).not.toContain("paper/portrait");
 if(status==="completed")expect(host.querySelector("header .tool-patch-file-name")?.textContent).toBe("文献画像");
});
it("keeps recorded names when a source is unavailable, never substituting the raw identity",async()=>{
 const host=await mount("failed","原始资源名称",false);
 expect(host.querySelector(".tool-row-compact .tool-patch-file-name")?.textContent).toBe("原始资源名称");
 expect(host.querySelector(".tool-row-compact .agent-source-hint")?.textContent).toBe("原始资源名称来源不可用");
});
it.each(["research_search_sources","research_find_sources","research_list_sources"])("uses the read resource name and readable hint for scoped %s",async name=>{
 directory.mockReturnValue(withSourceNamespaces({value:{kind:"root"},child:async(id:string)=>id==="paper"?{value:{kind:"directory",title:"Paper"},child:async(id:string)=>id==="portrait"?{value:{kind:"structuredObject",resource:{title:"文献画像",revision:3}},child:async()=>undefined}:undefined}:undefined}));
 const scoped=toolActivityRows([{type:"tool-call",callId:"scope",name,content:JSON.stringify({resourceId:"portrait",...name.includes("search")?{query:"word"}:{nameQuery:"portrait"}})},{type:"tool-result",callId:"scope",name,content:JSON.stringify({matches:[],scope:{sourceUrl:"source://library/paper/portrait"}})}])[0]!;
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 cleanups.push(async()=>{await act(async()=>root.unmount());host.remove();});
 await act(async()=>root.render(<ToolActivityHistoryRow row={scoped}/>));
 const title=host.querySelector(".tool-row-compact")!;
 expect(title.querySelector(".tool-read-file-name")?.textContent).toBe(name === "research_list_sources" ? "所有文献 / Paper / 文献画像" : "文献画像");
 expect(title.querySelector(".agent-source-hint")?.textContent).toContain("文献画像");
 expect(title.textContent).not.toContain("source://");if(name!=="research_list_sources")expect(title.textContent).not.toContain("范围");
 else expect(title.textContent).toContain("已列出文件（范围 ");
});
