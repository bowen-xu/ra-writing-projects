// @vitest-environment happy-dom
import {expect,it,vi} from "vitest";
import type {LiteratureItem} from "@research-assistant/core/literature";
import {createRecordWritingGateway} from "./recordWritingGateway";
import type {WritingGateway} from "./writingGateway";
import {writingFileKey} from "../../../../../../apps/web/src/core/public/writingStorage";
import {memoryWritingRecords,memoryWritingState} from "../../../../../../apps/web/src/app/runtime/testing/memoryWritingRecords";

vi.mock("../../../../../../apps/web/src/core/public/domainCapabilities",() => ({getOptionalLiteratureGateway: () => ({list: async () => [],get: getItem})}));
const item: LiteratureItem = {id:"library",itemType:"journalArticle",title:"Synthetic",abstractText:"",issuedYear:2026,containerTitle:"Journal",volume:"",issue:"",pages:"",doi:"",url:"",language:"",bibtexKey:"auto2026",
  creators:[{familyName:"Example",givenName:"Alice",literalName:"",role:"author"}],tags:[],readingStatus:"unread",attachments:[],projectIds:[],metadataSources:[],createdAt:"now",updatedAt:"now"};
const getItem = vi.fn(async () => item);
function fixture() {
  const state = memoryWritingState(), records = memoryWritingRecords(state), values = new Map<string,string>();
  const storage: Storage = {get length(){return values.size;},key: index => [...values.keys()][index] ?? null,getItem: key => values.get(key) ?? null,
    setItem: (key,value) => {values.set(key,value);},removeItem: key => {values.delete(key);},clear: () => {values.clear();}};
  const create = () => createRecordWritingGateway(records,{} as WritingGateway,storage,[{path:"local.bib",content:"@book{imported2026,title={Imported},year={2026}}"}]);
  return {state,records,create,gateway: create()};
}

it("adopts only bib bodies, all-entry reads stay fresh without source loads, and status uses headers",async () => {
  const f = fixture(), project = await f.gateway.createManuscript({title:"Read bounds"});
  for (let i = 0; i < 20; i++) await f.gateway.createFile(project.id,`chapter-${i}.tex`,"source text ".repeat(100));
  f.records.reads.length = 0;
  expect((await f.gateway.listBibliographyEntries(project.id,true)).map(row => row.citationKey)).toEqual(["imported2026"]);
  expect(f.records.reads.filter(row => row.store === "writingBodies")).toEqual([{store:"writingBodies",count:1}]);
  f.records.reads.length = 0;
  expect(await f.gateway.listBibliographyEntries(project.id)).toHaveLength(1);
  expect(f.records.reads.filter(row => row.store === "writingBodies")).toEqual([]);
  await f.gateway.bindCitation(project.id,{literatureItemId:item.id,requestedKey:"auto2026",bibtexEntry:"@article{auto2026,title={Synthetic}}"});
  f.records.reads.length = 0;
  const revision = f.state.revision;
  for (let i = 0; i < 5; i++) expect(await f.gateway.listBibliographyEntries(project.id,true)).toHaveLength(2);
  getItem.mockResolvedValueOnce({...item,title:"Updated library title"});
  expect((await f.gateway.listBibliographyEntries(project.id,true)).find(row => row.libraryItem)?.libraryItem?.title).toBe("Updated library title");
  expect((await f.create().listBibliographyEntries(project.id,true))).toHaveLength(2);
  expect((await f.gateway.getBibliographyStatus(project.id)).contentHash).toBeTypeOf("string");
  expect(f.records.reads.filter(row => row.store === "writingFiles")).toEqual([{store:"writingFiles",count:1}]);
  expect(f.records.reads.filter(row => row.store === "writingBodies")).toEqual([]);
  expect(f.state.revision).toBe(revision);
  f.records.reads.length = 0;
  expect((await f.gateway.listBibliographyEntries(project.id)).map(row => row.citationKey)).toEqual(["imported2026"]);
  expect(f.records.reads.filter(row => row.store === "writingBodies")).toHaveLength(21);
  expect(f.records.reads.filter(row => row.store === "writingBodies").every(row => row.count === 1)).toBe(true);
});

it("does not hide a missing source body when a usage-dependent query needs it",async () => {
  const f = fixture(), project = await f.gateway.createManuscript({title:"Missing source"});
  await f.gateway.bindCitation(project.id,{literatureItemId:item.id,requestedKey:"auto2026",bibtexEntry:"@article{auto2026,title={Synthetic}}"});
  f.state.stores.get("writingBodies")!.delete(writingFileKey(project.id,project.rootPath));
  expect(await f.gateway.listBibliographyEntries(project.id,true)).toHaveLength(2);
  await expect(f.gateway.listBibliographyEntries(project.id)).rejects.toMatchObject({code:"writing_file_missing"});
});

it("still rejects a missing imported bibliography body during initial adoption",async () => {
  const f = fixture(), project = await f.gateway.createManuscript({title:"Missing bibliography"});
  f.state.stores.get("writingBodies")!.delete(writingFileKey(project.id,"local.bib"));
  await expect(f.gateway.listBibliographyEntries(project.id,true)).rejects.toMatchObject({code:"writing_file_missing"});
});

it("projects import-only bibliographies without loading sources, but explicit cleanup still reads current usage",async () => {
  const f = fixture(), project = await f.gateway.createManuscript({title:"Import-only projection"});
  for (let i = 0; i < 20; i++) await f.gateway.createFile(project.id,`chapter-${i}.tex`,"Synthetic source");
  await f.gateway.saveFile({manuscriptId:project.id,relativePath:project.rootPath,content:"\\cite{imported2026}"});
  await f.gateway.listBibliographyEntries(project.id,true);f.records.reads.length = 0;
  for (const refresh of [() => f.gateway.syncBibliography(project.id,[]),() => f.gateway.regenerateBibliography(project.id),() => f.gateway.preserveBibliographyEdits(project.id)]) {
    await refresh();
  }
  expect(f.records.reads.filter(row => row.store === "writingBodies")).toEqual([]);
  expect((await f.gateway.readFile(project.id,"local.bib")).content).toContain("{imported2026,");
  f.records.reads.length = 0;
  expect(await f.gateway.removeUnusedImportedBibliographyEntries(project.id)).toBe(0);
  expect(f.records.reads.filter(row => row.store === "writingBodies")).toHaveLength(21);
  await f.gateway.saveFile({manuscriptId:project.id,relativePath:project.rootPath,content:""});
  expect(await f.gateway.removeUnusedImportedBibliographyEntries(project.id)).toBe(1);
  expect((await f.gateway.readFile(project.id,"local.bib")).content).not.toContain("{imported2026,");
});

it("does not mask missing source errors in explicit import cleanup or document opening",async () => {
  const f = fixture(), project = await f.gateway.createManuscript({title:"Import-only missing source"});
  await f.gateway.listBibliographyEntries(project.id,true);
  f.state.stores.get("writingBodies")!.delete(writingFileKey(project.id,project.rootPath));
  expect((await f.gateway.syncBibliography(project.id,[])).status).toBe("ready");
  await expect(f.gateway.removeUnusedImportedBibliographyEntries(project.id)).rejects.toMatchObject({code:"writing_file_missing"});
  await expect(f.gateway.readFile(project.id,project.rootPath)).rejects.toMatchObject({code:"writing_file_missing"});
  expect((await f.gateway.listBibliographyEntries(project.id,true)).map(row => row.citationKey)).toEqual(["imported2026"]);
});
