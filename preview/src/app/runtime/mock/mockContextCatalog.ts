import { READING_TEMPLATE_CATALOG_ID } from "@research-assistant/core/structured-resources";
import { getStructuredResourceGateway } from "@research-assistant/workbench-preview/structured-resource-gateway";
import { getAppRuntime } from "@research-assistant/workbench-preview/app-runtime";
import type { AgentContextPart, AgentContextSelection } from "@research-assistant/core/agent";
import { getLiteratureGateway } from "@research-assistant/literature-library-preview";
import { getNotesGateway } from "@research-assistant/workbench-preview/gateways-gateway";
import { getWritingGateway } from "../../../../../src/public/writingGateway.ts";
import {noteBlockId,notePageId} from "@research-assistant/core/notes";
import {NotesGatewayError} from "@research-assistant/data/notes";

/** The focused recommendation preserves the existing ordinary-note group and
 * reading-note leaf. It must not build the entire permission catalog merely
 * because an editor became visible. Admission still resolves real grants. */
export async function mockContextRecommendation(candidate:AgentContextSelection, signal?:AbortSignal):Promise<AgentContextSelection>{
  signal?.throwIfAborted();
  const resource=candidate.resource;
  if(resource.kind==="paper"){
    const paper=await getLiteratureGateway().get(resource.resourceId);
    signal?.throwIfAborted();
    if(!paper || paper.trashedAt || resource.attachmentId && !paper.attachments.some(file=>file.id===resource.attachmentId && file.mimeType==="application/pdf"))throw new Error("sourceUnavailable");
    return{label:paper.title,resource:{kind:"paperGroup",resourceId:paper.id,groupAccess:"readWrite",newMemberAccess:"readWrite",parts:[]}};
  }
  if(resource.kind==="manuscriptFile" || resource.kind==="manuscript"){
    const writing=getWritingGateway();
    const project=(await writing.listManuscripts()).find(item=>item.id===resource.resourceId && item.status==="active");
    const files=project && resource.kind==="manuscriptFile" ? await writing.listFiles(project.id) : [];
    signal?.throwIfAborted();
    if(!project || resource.kind==="manuscriptFile" && !files.some(file=>file.relativePath===resource.path && ["tex","bib","style"].includes(file.kind)))throw new Error("sourceUnavailable");
    return{label:project.title,resource:{kind:"manuscript",resourceId:project.id,groupAccess:"readWrite",newMemberAccess:"readWrite",parts:[]}};
  }
  if(resource.kind!=="note")throw new Error("invalidInput");
  const gateway=getNotesGateway();
  const page=(await gateway.listPageMetadata([notePageId(resource.resourceId)]))[0];
  signal?.throwIfAborted();
  if(!page||page.status!=="active")throw new Error("sourceUnavailable");
  try{await gateway.getReadingNote(noteBlockId(resource.resourceId));return candidate;}
  catch(reason){if(!(reason instanceof NotesGatewayError&&reason.code==="not_found"))throw reason;}
  return{label:`笔记 · ${page.title}`,resource:{kind:"noteGroup",resourceId:page.id,groupAccess:"readWrite",newMemberAccess:"readWrite",parts:[{resource:{kind:"note",resourceId:page.id},label:"正文",selected:true,access:"readWrite"}]}};
}

/** Application inventory I/O only; the dialog renders the production grouping controls. */
export async function mockContextCatalog(query: string): Promise<readonly AgentContextSelection[]> {
  const [papers, notes, reading, manuscripts] = await Promise.all([
    getLiteratureGateway().list(), getNotesGateway().listPages(), getNotesGateway().listReadingNotes(), getWritingGateway().listManuscripts(),
  ]);
  const part = (resource: AgentContextPart["resource"], label: string): AgentContextPart => ({resource, label, selected: true, access: resource.kind === "paper" ? "readOnly" : "readWrite"});
  const hasStructured=getAppRuntime().gateways.getStructuredResourceGateway !== undefined;
  const derived=hasStructured ? await getStructuredResourceGateway().list() : [];
  const paperResources=hasStructured ? (await Promise.all(papers.map(paper=>getStructuredResourceGateway().list(paper.id)))).flat() : [];
  const rows: AgentContextSelection[] = await Promise.all(papers.map(async paper => ({label: paper.title, resource: {kind: "paperGroup" as const, resourceId: paper.id, groupAccess:"readWrite" as const, newMemberAccess:"readWrite" as const, parts: [
    part({kind: "paperMetadata", resourceId: paper.id}, "元数据"),
    ...paper.attachments.filter(file => file.mimeType === "application/pdf").map(file => part({kind: "paper", resourceId: paper.id, attachmentId: file.id}, file.displayName)),
    part({kind: "paperNotes", resourceId: paper.id, excludedNoteIds: []}, "阅读笔记"),
    ...reading.filter(note => note.source.paperId === paper.id && note.pageId).map(note => ({...part({kind: "note", resourceId: note.pageId!}, `阅读笔记 · ${note.source.pageLabel ?? note.source.pageIndex + 1}`), selected: false})),
    ...(await getNotesGateway().listLiteratureNotes(paper.id)).map(note => ({...part({kind:"note",resourceId:note.page.id},note.page.title),selected:false})),
    ...(hasStructured ? paperResources.filter(value=>value.paperId===paper.id).map(value=>part({kind:"structuredObject",resourceId:value.id},value.title)) : [part({kind:"paperPortrait",resourceId:paper.id},"文献画像")]),
  ]}})));
  if(hasStructured) {
    rows.push({resource:{kind:"templateCatalog",resourceId:READING_TEMPLATE_CATALOG_ID,access:"readWrite"},label:"阅读模板 · 新建草稿权限"});
    rows.push(...derived.filter(value=>value.kind === "readingTemplate" && !value.paperId).map(value=>({resource:{kind:"structuredObject" as const,resourceId:value.id,access:"readOnly" as const},label:`阅读模板 · ${value.title}`})));
  }
  const readingIds = new Set(reading.map(note => note.pageId));
  rows.push(...notes.filter(note => !readingIds.has(note.id)).map(note => ({resource: {kind: "noteGroup" as const, resourceId: note.id, groupAccess:"readWrite" as const, newMemberAccess:"readWrite" as const, parts: [part({kind: "note", resourceId: note.id}, "正文")]}, label: `笔记 · ${note.title}`})));
  for (const manuscript of manuscripts) {
    const files = await getWritingGateway().listFiles(manuscript.id);
    const parts = files.filter(file => ["tex", "bib", "style"].includes(file.kind)).map(file => part({kind: "manuscriptFile", resourceId: manuscript.id, path: file.relativePath}, file.relativePath));
    rows.push({resource: {kind: "manuscript", resourceId: manuscript.id, groupAccess:"readWrite", newMemberAccess:"readWrite", parts}, label: manuscript.title});
  }
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => [row.label, ...("parts" in row.resource ? row.resource.parts.map(part => part.label) : [])].some(label => label.toLocaleLowerCase().includes(needle))).slice(0, 180);
}
