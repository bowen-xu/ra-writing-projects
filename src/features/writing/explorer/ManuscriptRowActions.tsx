import {useRef,useState} from "react";
import {Archive,Copy,Download,FileDown,MoreHorizontal,Trash2,Undo2} from "lucide-react";
import type {Manuscript} from "@research-assistant/writing";
import type {WritingGateway} from "../gateway";
import {WritingMenu,WritingMenuItem} from "../WritingMenu";
import {downloadManuscript} from "../transfer/downloadManuscript";
import {notify} from "@research-assistant/workbench-sdk/feedback";
import {ControlHint} from "@research-assistant/workbench-sdk/overlay";
import "./ManuscriptRowActions.css";

export interface ManuscriptLibraryOperations {
  readonly gateway: WritingGateway;
  readonly beforeAction: (item:Manuscript)=>Promise<boolean>;
  readonly onDuplicated: (item:Manuscript)=>void;
}
export function ManuscriptRowActions({item,operations,onStatusChange,onDelete}: {
  readonly item:Manuscript; readonly operations?:ManuscriptLibraryOperations | undefined;
  readonly onStatusChange:()=>void; readonly onDelete:(trigger:HTMLButtonElement|null)=>void;
}) {
  const trigger=useRef<HTMLButtonElement>(null),pending=useRef(false);
  const [busy,setBusy]=useState(false);
  async function run(kind:"duplicate"|"source"|"pdf") {
    if(!operations||pending.current)return;
    pending.current=true;setBusy(true);
    try {
      if(!await operations.beforeAction(item))return;
      if(kind==="duplicate") {
        if(!operations.gateway.duplicateManuscript)throw new Error("writing_duplicate_unavailable：当前环境不支持复制稿件");
        operations.onDuplicated(await operations.gateway.duplicateManuscript(item.id));
        notify.success("已创建稿件副本");
      } else {
        if(kind==="pdf"&&!await operations.gateway.getLatestPdfCompileRun(item.id))throw new Error("writing_pdf_missing：尚无生成的 PDF，请先打开稿件并编译");
        const result=await downloadManuscript(operations.gateway,item,kind);
        notify.success("已下载"+(kind==="pdf"?" PDF":"源码 ZIP"),{description:result.destinationPath});
      }
    }catch(reason){notify.error(reason instanceof Error?reason.message:String(reason));}
    finally{pending.current=false;setBusy(false);}
  }
  const actions = [
    {label:"复制稿件",Icon:Copy,disabled:!operations?.gateway.duplicateManuscript,invoke:()=>void run("duplicate")},
    {label:"下载 ZIP",Icon:Download,disabled:!operations?.gateway.supportsCompilation,invoke:()=>void run("source")},
    {label:"下载 PDF",Icon:FileDown,disabled:!operations?.gateway.supportsCompilation,invoke:()=>void run("pdf")},
    {label:item.status==="archived"?"恢复归档":"归档",Icon:item.status==="archived"?Undo2:Archive,disabled:false,invoke:onStatusChange},
    {label:item.status==="archived"?"永久删除":"删除",Icon:Trash2,disabled:false,invoke:onDelete},
  ];
  return <div className="writing-manuscript-actions" data-busy={busy || undefined}>
    <div className="writing-manuscript-inline" role="group" aria-label={`稿件操作 ${item.title}`}>
      {actions.map(({label,Icon,disabled,invoke})=><ControlHint key={label} content={label}><button type="button" className="writing-icon-button" aria-label={`${label} ${item.title}`} disabled={busy||disabled} onClick={event=>invoke(event.currentTarget)}><Icon size={18}/></button></ControlHint>)}
    </div>
    <WritingMenu className="writing-manuscript-overflow" contentClassName="writing-file-options writing-manuscript-menu" portal triggerClassName="writing-icon-button" label={`稿件操作 ${item.title}`} trigger={<MoreHorizontal size={18}/>} triggerRef={trigger} disabled={busy}>
      {actions.map(({label,Icon,disabled,invoke})=><WritingMenuItem key={label} disabled={busy||disabled} onClick={()=>invoke(trigger.current)}><Icon size={16}/>{label}</WritingMenuItem>)}
    </WritingMenu>
  </div>;
}
