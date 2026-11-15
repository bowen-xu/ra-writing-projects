import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { LITERATURE_TYPE_OPTIONS } from "@research-assistant/core/literature";
import { applyLiteratureCreatorInput, createLiteratureCreatorInput } from "@research-assistant/core/literature";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import type { LiteratureDraft, LiteratureMetadataPatch } from "@research-assistant/core/literature";
import type { ProjectBibliographyEntry } from "@research-assistant/writing";
import type { LiteratureGateway } from "@research-assistant/data/literature";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import type { WritingGateway } from "../gateway";
import { errorMessage } from "../workspaceState";
import { promoteBibliographyEntries } from "./bibliographyManagement";
import "./BibliographyManager.css";

const FIELDS = [
  ["itemType","条目类型"],["title","标题"],["issuedYear","年份"],["creators","作者"],["containerTitle","期刊／出版物"],
  ["conferenceName","会议"],["proceedingsTitle","论文集"],["place","地点"],["volume","卷"],["issue","期"],["pages","页码"],["doi","DOI"],["url","URL"],["language","语言"],["abstractText","摘要"],
] as const;
type Field = typeof FIELDS[number][0];
function display(draft: LiteratureDraft, field: Field): string {
  if (field === "creators") return draft.creators.map(p => p.literalName || [p.familyName,p.givenName].filter(Boolean).join(", ")).join("；");
  return String(draft[field] ?? "");
}
interface Props {
  readonly manuscriptId: string;
  readonly gateway: WritingGateway;
  readonly literature: Pick<LiteratureGateway, "get" | "list" | "save" | "updateMetadataField"> | undefined;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void>;
  readonly onInsert: (key: string) => void;
  readonly onBeforeCleanup: () => Promise<void>;
}
/** The same manager is mounted by production and mock-data previews. */
export function BibliographyManager(props: Props): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [entries,setEntries] = useState<readonly ProjectBibliographyEntry[]>([]);
  const [selected,setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editing,setEditing] = useState<ProjectBibliographyEntry>();
  const [draft,setDraft] = useState<LiteratureDraft>();
  const [query,setQuery] = useState("");
  const [busy,setBusy] = useState(true);
  const owner = useRef(0);
  const inFlight = useRef(false);
  async function reload(): Promise<void> { const rows=await props.gateway.listBibliographyEntries(props.manuscriptId);setEntries(rows);setEditing(current=>current?rows.find(row=>row.id===current.id):undefined); }
  useEffect(() => {
    const previous=document.activeElement;
    const dialog=ref.current; dialog?.showModal(); const epoch=++owner.current;
    void props.gateway.listBibliographyEntries(props.manuscriptId).then(rows => {if(owner.current === epoch)setEntries(rows);})
      .catch(reason => {if(owner.current===epoch)notify.error(errorMessage(reason));}).finally(()=>{if(owner.current===epoch)setBusy(false);});
    return () => {owner.current++;dialog?.close();if(previous instanceof HTMLElement && previous.isConnected)previous.focus();};
  },[props.gateway,props.manuscriptId]);
  async function perform(operation: () => Promise<void>): Promise<void> {
    if(busy || inFlight.current)return;inFlight.current=true;setBusy(true);
    try {await operation();}
    catch(reason) {notify.error(errorMessage(reason));}
    finally {try{await props.onChanged();}catch(reason){notify.error(errorMessage(reason));}try{await reload();}catch(reason){notify.error(errorMessage(reason));}inFlight.current=false;setBusy(false);}
  }
  const linked = (entry: ProjectBibliographyEntry) => !!(entry.libraryItemId || entry.libraryItem || entry.id.startsWith("binding:"));
  const readOnlyLink = (entry: ProjectBibliographyEntry) => linked(entry) && (!props.literature || !entry.libraryItem);
  function compare(entry: ProjectBibliographyEntry): void {setEditing(entry);setDraft(entry.libraryItem ?? entry.current);}
  async function save(): Promise<void> {
    if(!editing || !draft)return;
    const row=editing,value=draft;
    if (readOnlyLink(row)) {notify.error(props.literature ? "citation_source_not_found：已关联来源暂不可用，原引用与书目保留。" : "literature_citations_unavailable：文献插件未装配，原关联与书目保留。"); return;}
    await perform(async()=>{
      if(row.libraryItem){
        if (!props.literature) throw new Error("literature_citations_unavailable：文献插件未装配，关联版本已保留。");
        const library=row.libraryItem;
        const fresh=await props.literature.get(library.id);
        if(FIELDS.some(([key])=>display(fresh,key)!==display(library,key)))throw new Error("文献库条目已变化，请重新打开对照后保存。");
        for(const [key] of FIELDS){
          if(JSON.stringify(value[key])===JSON.stringify(library[key]))continue;
          const patch: LiteratureMetadataPatch = key === "issuedYear" ? {fieldName:key,value:value.issuedYear ?? null}
            : key === "creators" ? {fieldName:key,value:value.creators} : key === "itemType" ? {fieldName:key,value:value.itemType} : {fieldName:key,value:value[key] ?? ""};
          await props.literature.updateMetadataField(library.id,patch);
        }
        await props.gateway.linkBibliographyEntry(props.manuscriptId,row.id,library.id);
      }else await props.gateway.updateBibliographyEntry(props.manuscriptId,row.id,row.bibtexEntry,value);
      setEditing(undefined);setDraft(undefined);notify.success(row.libraryItem ? "已更新文献库并同步稿件引用" : "已保存稿件内条目");
    });
  }
  function promote(rows: readonly ProjectBibliographyEntry[]): void {
    void perform(async()=>{if (!props.literature) throw new Error("literature_citations_unavailable：文献插件未装配，稿内条目已保留。");const count=await promoteBibliographyEntries(rows,props.literature,props.gateway);setSelected(new Set());notify.success(`已将 ${count} 个条目加入文献库或关联已有记录`);});
  }
  const visible=entries.filter(row=>`${row.citationKey} ${row.current.title} ${row.current.doi}`.toLowerCase().includes(query.toLowerCase()));
  return <dialog ref={ref} className="bibliography-manager" aria-labelledby="bibliography-manager-title" onCancel={event=>{event.preventDefault();if(!busy)props.onClose();}}>
    <header><strong id="bibliography-manager-title">参考文献管理</strong><button type="button" aria-label="关闭参考文献管理" disabled={busy} onClick={props.onClose}><X size={16}/></button></header>
    {!props.literature && <p role="status">literature_citations_unavailable：文献插件未装配；稿内书目和已有引用保留，跨库编辑与加入文献库暂不可用。</p>}
    {editing && draft ? <>
      <div className="bibliography-manager-tools"><button type="button" disabled={busy} onClick={()=>{setEditing(undefined);setDraft(undefined);}}><ArrowLeft size={14}/>返回条目</button><code>{editing.citationKey}</code><span>{linked(editing) ? "关联文献库" : "仅此稿件"}</span></div>
      <div className="bibliography-compare"><table><thead><tr><th>字段</th><th>导入版本</th><th>{readOnlyLink(editing) ? "已保存版本（只读）" : linked(editing) ? "文献库 · 拟保存" : "稿件 · 拟保存"}</th></tr></thead><tbody>
        {FIELDS.map(([key,label])=><tr key={key}><th>{label}</th><td><span>{display(editing.imported,key)||"—"}</span>{display(editing.imported,key)!==display(draft,key)&&<ControlHint content={`采用导入${label}`}><button type="button" aria-label={`采用导入${label}`} disabled={busy||readOnlyLink(editing)} onClick={()=>setDraft({...draft,[key]:editing.imported[key]})}><ArrowRight size={13}/></button></ControlHint>}</td><td>
          {key === "itemType" ? <select aria-label="编辑条目类型" disabled={busy||readOnlyLink(editing)} value={draft.itemType} onChange={event=>{const value=LITERATURE_TYPE_OPTIONS.find(option=>option.value===event.target.value)?.value;if(value)setDraft({...draft,itemType:value});}}>{LITERATURE_TYPE_OPTIONS.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select> : key==="creators" ? <ControlHint content="多个作者用分号分隔，姓名使用：姓, 名"><input aria-label="编辑作者" disabled={busy||readOnlyLink(editing)} value={createLiteratureCreatorInput(draft.creators).value} onChange={event=>setDraft(applyLiteratureCreatorInput(draft,{value:event.target.value,edited:true}))}/></ControlHint> : <input aria-label={`编辑${label}`} type={key==="issuedYear"?"number":"text"} disabled={busy||readOnlyLink(editing)} value={display(draft,key)} onChange={event=>setDraft({...draft,[key]:key==="issuedYear" ? event.target.value ? Number(event.target.value) : undefined : event.target.value})}/>}
        </td></tr>)}
      </tbody></table></div>
      <footer><span>引用键保持不变。{readOnlyLink(editing) ? "关联来源暂不可用；当前为已保存版本，只读保留原引用键与关联。" : editing.libraryItem ? "保存会更新文献库中的这条记录。" : "保存仅影响此稿件。"}</span><button type="button" disabled={busy||!draft.title.trim()||readOnlyLink(editing)} onClick={()=>void save()}><Check size={14}/>{editing.libraryItem?"更新文献库":"保存条目"}</button></footer>
    </> : <>
      <div className="bibliography-manager-tools"><input aria-label="搜索稿件参考文献" placeholder="搜索标题、引用键或 DOI" value={query} onChange={event=>setQuery(event.target.value)}/><button type="button" disabled={busy||!props.literature||!entries.some(row=>selected.has(row.id)&&!linked(row))} onClick={()=>promote(entries.filter(row=>selected.has(row.id)))}>将所选加入文献库</button><button type="button" disabled={busy || !entries.some(row => !row.id.startsWith("binding:"))} onClick={()=>void perform(async()=>{await props.onBeforeCleanup();const count=await props.gateway.removeUnusedImportedBibliographyEntries(props.manuscriptId);notify.success(`已清理 ${count} 个未使用导入条目`);})}>清理未使用导入条目</button></div>
      <div className="bibliography-manager-list" aria-busy={busy}>{!busy&&!entries.length&&<p>此稿件还没有导入参考文献。可通过“文件 → 上传资源”导入 .bib 文件。</p>}
        {visible.map(row=><article key={row.id}><input type="checkbox" aria-label={`选择 ${row.citationKey}`} checked={selected.has(row.id)} disabled={busy||linked(row)} onChange={event=>setSelected(current=>{const next=new Set(current);event.target.checked?next.add(row.id):next.delete(row.id);return next;})}/><div><strong>{row.libraryItem?.title ?? row.current.title}</strong><small><code>{row.citationKey}</code> · {linked(row)?props.literature&&row.libraryItem?"文献库":"关联文献（暂不可用）":"仅此稿件"} · {row.paths.join("、")}</small></div><div className="bibliography-row-actions"><button type="button" disabled={busy} onClick={()=>compare(row)}>{readOnlyLink(row)?"查看已保存版本":row.libraryItem?"对照编辑":"编辑"}</button>{!linked(row)&&<button type="button" disabled={busy||!props.literature} onClick={()=>promote([row])}>加入文献库</button>}<button type="button" disabled={busy} onClick={()=>props.onInsert(row.citationKey)}>插入引用</button></div></article>)}
      </div><footer><span>.bib 为只读生成文件；导入不会自动新增文献库记录。</span></footer>
    </>}
  </dialog>;
}
