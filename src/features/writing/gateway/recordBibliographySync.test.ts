// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from "vitest";
import {exportLiterature} from "@research-assistant/core/citation";
import {emptyLiteratureDraft,type LiteratureItem} from "@research-assistant/core/literature";
import {parseManuscriptPath,type BibliographyEntryInput} from "@research-assistant/writing";
import {createRecordWritingGateway} from "./recordWritingGateway";
import {writingFileKey} from "../../../../../../apps/web/src/core/public/writingStorage";
import type {WritingGateway} from "./writingGateway";
import {memoryWritingRecords,memoryWritingState} from "../../../../../../apps/web/src/app/runtime/testing/memoryWritingRecords";

const {items} = vi.hoisted(() => ({items:new Map<string,LiteratureItem>()}));
vi.mock("../../../../../../apps/web/src/core/public/domainCapabilities",() => ({getOptionalLiteratureGateway: () => ({
  list:async () => [...items.values()],get:async (id: string) => {const item = items.get(id);if (!item) throw Error("missing synthetic literature");return item;},
})}));
afterEach(() => items.clear());
async function fixture(count = 0) {
  const values = new Map<string,string>();
  const storage: Storage = {get length(){return values.size;},key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,setItem: (key,value) => {values.set(key,value);},removeItem: key => {values.delete(key);},clear: () => values.clear()};
  const state = memoryWritingState(), records = memoryWritingRecords(state);
  const gateway = createRecordWritingGateway(records,{} as WritingGateway,storage);
  const project = await gateway.createManuscript({title:"Sync read bounds"});
  await gateway.saveFile({manuscriptId:project.id,relativePath:parseManuscriptPath("main.tex"),content:"\\nocite{*}"});
  for (let i = 0; i < 8; i++) await gateway.createFile(project.id,`chapter-${i}.tex`,"Synthetic source");
  const inputs: BibliographyEntryInput[] = [];
  for (let i = 0; i < count; i++) {
    const item: LiteratureItem = {...emptyLiteratureDraft(),id:`item-${i}`,title:`Synthetic ${i}`,bibtexKey:`key${i}`,
      readingStatus:"unread",attachments:[],projectIds:[],metadataSources:[],createdAt:"now",updatedAt:"now"};
    items.set(item.id,item);
    const input = {literatureItemId:item.id,requestedKey:item.bibtexKey,bibtexEntry:exportLiterature([item],"bibtex")};
    inputs.push(input);await gateway.bindCitation(project.id,input);
  }
  records.reads.length = 0;
  return {state,records,gateway,project,inputs,
    input: (index: number) => {const input = inputs[index];if (!input) throw Error("Synthetic binding fixture is missing");return input;},
    bodies: () => records.reads.filter(row => row.store === "writingBodies").reduce((sum,row) => sum + row.count,0)};
}

it("does not load source bodies when a prepared empty project has no bibliography output",async () => {
  const f = await fixture();
  await f.gateway.listBibliographyEntries(f.project.id,true);f.records.reads.length = 0;
  expect((await f.gateway.syncBibliography(f.project.id,[])).status).toBe("ready");
  expect(f.bodies()).toBe(0);
  // Missing source data is immaterial to a projection with no output, but must
  // still be rejected by the canonical file read when the document is opened.
  f.state.stores.get("writingBodies")?.delete(writingFileKey(f.project.id,"main.tex"));
  await f.gateway.syncBibliography(f.project.id,[]);
  await expect(f.gateway.readFile(f.project.id,"main.tex")).rejects.toMatchObject({code:"writing_file_missing"});
});

it("projects identical ordered bindings once, still observing source deletion and undo",async () => {
  const f = await fixture(12), before = await f.gateway.listCitationBindings(f.project.id);
  await f.gateway.syncBibliography(f.project.id,f.inputs);
  expect(f.bodies()).toBe(9);expect(await f.gateway.listCitationBindings(f.project.id)).toEqual(before);
  expect(f.state.checkpointRevision).toBe(0);
  await f.gateway.saveFile({manuscriptId:f.project.id,relativePath:parseManuscriptPath("main.tex"),content:"\\cite{key0}"});
  f.records.reads.length = 0;await f.gateway.syncBibliography(f.project.id,f.inputs);expect(f.bodies()).toBe(9);
  const projected = (await f.gateway.readFile(f.project.id,"references.bib")).content;
  expect(projected).toContain("{key0,");expect(projected).not.toContain("{key1,");
  await f.gateway.saveFile({manuscriptId:f.project.id,relativePath:parseManuscriptPath("main.tex"),content:"\\nocite{*}"});
  f.records.reads.length = 0;await f.gateway.syncBibliography(f.project.id,f.inputs);expect(f.bodies()).toBe(9);
  expect((await f.gateway.readFile(f.project.id,"references.bib")).content).toContain("{key11,");
  expect(await f.gateway.listCitationBindings(f.project.id)).toEqual(before);
});

it("retains the original sequential update/order path when one binding changes or inputs reorder",async () => {
  const f = await fixture(2), updated = {...f.input(0),bibtexEntry:"@article{other,title={Changed metadata}}"};
  await f.gateway.syncBibliography(f.project.id,[updated,f.input(1)]);
  expect(f.bodies()).toBe(27);
  let bound = await f.gateway.listCitationBindings(f.project.id);
  expect(bound[0]?.bibtexEntry).toContain("Changed metadata");expect(bound[0]?.citationKey).toBe("key0");
  f.records.reads.length = 0;
  await f.gateway.syncBibliography(f.project.id,[f.input(1),updated]);
  expect(f.bodies()).toBe(27);bound = await f.gateway.listCitationBindings(f.project.id);
  expect(bound.map(row => row.literatureItemId)).toEqual(["item-1","item-0"]);
});

it.each([false,true])("preserves the applied prefix and original error after invalid input (changed prefix: %s)",async changed => {
  const f = await fixture(2), first = changed ? {...f.input(0),bibtexEntry:"@article{key0,title={Applied prefix}}"} : f.input(0);
  await expect(f.gateway.syncBibliography(f.project.id,[first,{...f.input(1),bibtexEntry:"invalid"}])).rejects.toThrow("This format is not supported or recognized");
  expect(f.bodies()).toBe(9);
  const bound = await f.gateway.listCitationBindings(f.project.id);
  expect(bound.map(row => row.literatureItemId)).toEqual(["item-1","item-0"]);
  expect(bound[1]?.bibtexEntry).toContain(changed ? "Applied prefix" : "Synthetic 0");
  expect((await f.gateway.readFile(f.project.id,"references.bib")).content).toContain(changed ? "Applied prefix" : "Synthetic 0");
});

it("does not replace a required source failure with success for unchanged bindings",async () => {
  const f = await fixture(2);
  f.state.stores.get("writingBodies")?.delete(writingFileKey(f.project.id,"chapter-2.tex"));
  await expect(f.gateway.syncBibliography(f.project.id,f.inputs)).rejects.toMatchObject({code:"writing_file_missing"});
});
