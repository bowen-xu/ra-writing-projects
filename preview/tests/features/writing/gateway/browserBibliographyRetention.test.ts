// @vitest-environment happy-dom
import {expect, it, vi} from "vitest";
import {parseManuscriptPath, type ManuscriptFileContent} from "@research-assistant/writing";
import type {LiteratureItem} from "@research-assistant/core/literature";
vi.mock("@research-assistant/workbench-preview/domain-capabilities", () => ({getOptionalLiteratureGateway: () => ({list: async () => [item], get: getItem})}));
import {createBrowserBibliography} from "@research-assistant/writing-projects-preview/browser-bibliography";

const item: LiteratureItem = {id:"library",itemType:"journalArticle",title:"Synthetic",abstractText:"",issuedYear:2026,
  containerTitle:"Journal",volume:"",issue:"",pages:"",doi:"",url:"",language:"",bibtexKey:"auto2026",
  creators:[{familyName:"Example",givenName:"Alice",literalName:"",role:"author"}],tags:[],readingStatus:"unread",
  attachments:[],projectIds:[],metadataSources:[],createdAt:"now",updatedAt:"now"};
const getItem=vi.fn(async()=>item);

function fixture() {
  const records = new Map<string, ManuscriptFileContent>();
  const put = (path: string, content: string) => records.set(path, {relativePath:parseManuscriptPath(path),content,sha256:content});
  put("local.bib", "@book{imported2026,title={An imported record},year={2026}}\n");
  put("main.tex", "\\cite{auto2026}");
  const port = {list: () => [...records.values()],stat: (_id: string,path: string) => records.get(path), write: async (_id: string, path: string, content: string) => {put(path,content);}};
  const values = new Map<string,string>();
  const storage: Storage = {get length(){return values.size;}, key:index=>[...values.keys()][index]??null,
    getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);},removeItem:key=>{values.delete(key);},clear:()=>values.clear()};
  return {records,put,port,storage,gateway:createBrowserBibliography(storage,port)};
}

it("prunes unused automatic projections and restores their stable bindings after reopen/undo", async () => {
  const f=fixture();
  const binding=await f.gateway.bindCitation("m",{literatureItemId:item.id,requestedKey:"auto2026",bibtexEntry:"@article{auto2026,title={Synthetic},year={2026}}"});
  expect(f.records.get("references.bib")?.content).toContain("auto2026");
  f.put("main.tex", "");await f.gateway.syncBibliography("m",[]);
  expect(f.records.get("references.bib")?.content).not.toContain("auto2026");
  expect(f.records.get("local.bib")?.content).toContain("imported2026");
  expect((await f.gateway.listBibliographyEntries("m")).map(row=>row.citationKey)).toEqual(["imported2026"]);
  expect(await f.gateway.listCitationBindings("m")).toEqual([binding]);
  expect(await f.gateway.listBibliographyEntries("m",true)).toHaveLength(2);
  const reopened=createBrowserBibliography(f.storage,f.port);
  f.put("main.tex", "\\cite{auto2026}");await reopened.syncBibliography("m",[]);
  expect(f.records.get("references.bib")?.content.match(/@article/gu)).toHaveLength(1);
  expect(await reopened.listCitationBindings("m")).toEqual([binding]);
});

it("retains references in other chapters and nocite, and only explicitly cleans unused imports",async()=>{
  const f=fixture();
  await f.gateway.bindCitation("m",{literatureItemId:item.id,requestedKey:"auto2026",bibtexEntry:"@article{auto2026,title={Synthetic}}"});
  f.put("main.tex", "");f.put("chapter.tex", "\\cite{auto2026}");await f.gateway.syncBibliography("m",[]);
  expect(f.records.get("references.bib")?.content).toContain("auto2026");
  f.put("chapter.tex", "\\nocite{*}");await f.gateway.syncBibliography("m",[]);
  expect(await f.gateway.removeUnusedImportedBibliographyEntries("m")).toBe(0);
  f.put("chapter.tex", "");await f.gateway.syncBibliography("m",[]);
  expect(f.records.get("references.bib")?.content).not.toContain("auto2026");
  expect(await f.gateway.removeUnusedImportedBibliographyEntries("m")).toBe(1);
  expect(f.records.get("local.bib")?.content).not.toContain("imported2026");
  expect(await f.gateway.listBibliographyEntries("m")).toEqual([]);
  expect(await f.gateway.listCitationBindings("m")).toHaveLength(1);
});

it("retains imported provenance when the entry matches the library and is later cited",async()=>{
  const f=fixture();f.put("local.bib","@article{importKey,title={Synthetic},author={Example, Alice},year={2026}}\n");
  const rows=await f.gateway.listBibliographyEntries("m");expect(rows[0]?.libraryItem?.id).toBe(item.id);
  const binding=await f.gateway.bindCitation("m",{literatureItemId:item.id,requestedKey:"otherKey",bibtexEntry:"@article{otherKey,title={Synthetic}}"});
  expect(binding.citationKey).toBe("importKey");
  f.put("main.tex", "");await f.gateway.syncBibliography("m",[]);
  expect((await f.gateway.listBibliographyEntries("m"))[0]?.citationKey).toBe("importKey");
  expect(f.records.get("local.bib")?.content).toContain("importKey");
});

it("serializes a delayed metadata refresh before explicit cleanup so imports cannot reappear",async()=>{
  const f=fixture();f.put("local.bib","@article{importKey,title={Synthetic},author={Example, Alice},year={2026}}\n");
  await f.gateway.listBibliographyEntries("m");
  let finish!:(value:LiteratureItem)=>void;getItem.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const refresh=f.gateway.syncBibliography("m",[]);
  await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
  const cleanup=f.gateway.removeUnusedImportedBibliographyEntries("m");
  finish(item);await refresh;expect(await cleanup).toBe(1);
  expect(await f.gateway.listBibliographyEntries("m")).toEqual([]);
  expect(f.records.get("local.bib")?.content).not.toContain("importKey");
});
