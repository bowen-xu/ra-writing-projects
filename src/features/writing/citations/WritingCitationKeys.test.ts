// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { exportLiterature } from "@research-assistant/core/citation";
import { emptyLiteratureDraft, type LiteratureItem } from "@research-assistant/core/literature";
import { parseManuscriptPath } from "@research-assistant/writing";
import { createBrowserWritingGateway } from "../gateway/browserWritingGateway";
import { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import { getWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { WritingCheckpointPersistence } from "../persistence/WritingCheckpointPersistence";
import { WritingFileSaveQueue } from "../persistence/WritingFileSaveQueue";
import { WritingCitationKeys } from "./WritingCitationKeys";
import { citationLabels } from "./citationLabels";
import {memoryWritingRecords, memoryWritingState, registerWritingRecords} from "../../../../../../apps/web/src/app/runtime/testing/memoryWritingRecords";

const {library} = vi.hoisted(() => ({library:new Map<string,LiteratureItem>()}));
vi.mock("../../../../../../apps/web/src/core/public/domainCapabilities", () => ({getOptionalLiteratureGateway: () => ({list:async () => [...library.values()],get:async (id:string) => library.get(id)!})}));
afterEach(() => library.clear());
function createGateway(mode: "memory" | "records", options?: Parameters<typeof createBrowserWritingGateway>[1]) {
  if (mode === "memory") return createBrowserWritingGateway(undefined, options);
  const values = new Map<string, string>();
  const storage: Storage = {get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); }, clear: () => values.clear()};
  registerWritingRecords(storage, memoryWritingRecords(memoryWritingState()));
  return createBrowserWritingGateway(storage, options);
}
it.each(["memory", "records"] as const)("migrates case-only legacy collisions across source, review, bib and reopen (%s)", async mode => {
  const raw = createGateway(mode, {initialBibliography: [{
    path: "references.bib",
    content: "@article{xu2026Vision,title={Vision A},year={2026}}\n@article{xu2026vision,title={Vision B},year={2026}}",
  }]});
  const access = createExclusiveWritingGateway(raw), gateway = access.gateway;
  const {id} = await gateway.createManuscript({title: "Lowercase migration"});
  const source = "\\cite{xu2026Vision,xu2026vision} original";
  await gateway.saveFile({manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), content: source});
  await gateway.createFile(id, "other.tex", "\\cite{xu2026Vision}");
  const previous = await gateway.listBibliographyEntries(id);
  const sessions = new WritingFileSessions();
  const checkpoints = new WritingCheckpointPersistence(sessions, getWritingCheckpointGateway(), reason => {throw reason;});
  const saves = new WritingFileSaveQueue(sessions, checkpoints, gateway, reason => {throw reason;});
  const disconnect = checkpoints.connect(), disconnectSaves = saves.connect();
  try {
    const main = await checkpoints.open(id, await gateway.readFile(id, "main.tex"));
    expect(main.applyAgent("edit", main.read().version, source.replace("original", "revised"))).toBe("applied");
    const manager = new WritingCitationKeys(access, sessions, checkpoints, saves);
    expect(await manager.reconcile(id)).toBe(true);
    const entries = await gateway.listBibliographyEntries(id);
    expect(entries.map(row => row.id).sort()).toEqual(previous.map(row => row.id).sort());
    expect(entries.map(row => row.citationKey).sort()).toEqual(["xu2026vision:a", "xu2026vision:b"]);
    expect(entries.every(row => row.baseKey === "xu2026vision")).toBe(true);
    const oldToNew = new Map(previous.map(row => [row.citationKey, entries.find(next => next.id === row.id)!.citationKey]));
    const migrated = "\\cite{" + oldToNew.get("xu2026Vision") + "," + oldToNew.get("xu2026vision") + "}";
    expect(main.read().content).toBe(migrated + " revised");
    expect(main.read().reviewBaseline).toBe(migrated + " original");
    expect((await gateway.readFile(id, "other.tex")).content).toBe("\\cite{" + oldToNew.get("xu2026Vision") + "}");
    expect((await gateway.readFile(id, "references.bib")).content).not.toContain("xu2026Vision");
    const saved = main.read();
    expect(await manager.reconcile(id)).toBe(false);
    expect(main.read()).toEqual(saved);
    await checkpoints.flushAll();
    const reopened = new WritingCheckpointPersistence(new WritingFileSessions(), getWritingCheckpointGateway(), reason => {throw reason;});
    expect((await reopened.open(id, await gateway.readFile(id, "main.tex"))).read()).toEqual(saved);
  } finally {disconnectSaves(); disconnect(); await checkpoints.flushAll();}
});

it.each(["memory", "records"] as const)("coordinates bindings, background files, pending review, deletion and reopen (%s)", async mode => {
  for (const id of ["A","B"]) library.set(id,{...emptyLiteratureDraft(),id,bibtexKey:"xu2026vision",title:`Vision ${id}`,issuedYear:2026,
    creators:[{familyName:"Xu",givenName:"",literalName:"",role:"author"}],attachments:[],readingStatus:"unread",projectIds:[],metadataSources:[],createdAt:"now",updatedAt:"now"});
  const raw = createGateway(mode);
  const access = createExclusiveWritingGateway(raw), gateway = access.gateway;
  const manuscript = await gateway.createManuscript({title:"Synthetic"}), id = manuscript.id;
  await gateway.saveFile({manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),content:"\\cite{xu2026vision} original"});
  await gateway.createFile(id,"other.tex","\\cite{xu2026vision}");
  const bind = async (itemId:string) => gateway.bindCitation(id,{literatureItemId:itemId,requestedKey:"xu2026vision",bibtexEntry:exportLiterature([library.get(itemId)!],"bibtex")});
  await bind("A");
  const sessions = new WritingFileSessions();
  const checkpoints = new WritingCheckpointPersistence(sessions,getWritingCheckpointGateway(),reason => {throw reason;});
  const saves = new WritingFileSaveQueue(sessions,checkpoints,gateway,reason => {throw reason;});
  const disconnect = checkpoints.connect(), disconnectSaves = saves.connect();
  try {
    const main = await checkpoints.open(id,await gateway.readFile(id,"main.tex"));
    const review = main.read();
    expect(main.applyAgent("edit",review.version,review.content.replace("original","revised"))).toBe("applied");
    await saves.save(main.identity);
    const manager = new WritingCitationKeys(access,sessions,checkpoints,saves);
    await manager.reconcile(id);
    await bind("B");
    await manager.reconcile(id,["B"]);
    let entries = await gateway.listBibliographyEntries(id,true);
    expect(entries.map(row => row.citationKey).sort()).toEqual(["xu2026vision:a","xu2026vision:b"]);
    expect(main.read().content).toBe("\\cite{xu2026vision:a} revised");
    expect(main.read().reviewBaseline).toBe("\\cite{xu2026vision:a} original");
    expect((await gateway.readFile(id,"other.tex")).content).toBe("\\cite{xu2026vision:a}");
    expect(citationLabels(entries).map(row => row.yearSuffix).sort()).toEqual(["a","b"]);
    // Persist B, then remove A everywhere; B must regain the bare base.
    main.dispatch({changes:{from:0,to:main.state.doc.length,insert:"\\cite{xu2026vision:b} revised"},userEvent:"input.type"});
    const other = sessions.get({manuscriptId:id,relativePath:"other.tex"})!;
    other.dispatch({changes:{from:0,to:other.state.doc.length},userEvent:"delete.cut"});
    await saves.save(main.identity);await saves.save(other.identity);
    await manager.reconcile(id);
    entries = await gateway.listBibliographyEntries(id);
    expect(entries.map(row => row.citationKey)).toEqual(["xu2026vision"]);
    expect(citationLabels(entries)[0]?.yearSuffix).toBeUndefined();
    expect(main.read().content).toBe("\\cite{xu2026vision} revised");
    const bib = (await gateway.readFile(id,"references.bib")).content;
    expect(bib).toContain("{xu2026vision,");
    expect(bib).not.toContain("xu2026vision:b,");
    await checkpoints.flushAll();
    const reopened = new WritingCheckpointPersistence(new WritingFileSessions(),getWritingCheckpointGateway(),reason => {throw reason;});
    const reopenedMain = await reopened.open(id,await gateway.readFile(id,"main.tex"));
    expect(reopenedMain.read()).toEqual(main.read());
  } finally {disconnectSaves();disconnect();await checkpoints.flushAll();}
});
