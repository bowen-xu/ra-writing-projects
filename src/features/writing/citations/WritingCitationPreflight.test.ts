// @vitest-environment happy-dom
import {expect, it, vi} from "vitest";
import {emptyLiteratureDraft, type LiteratureItem} from "@research-assistant/core/literature";
import {planCitationKeys, type ProjectBibliographyEntry} from "@research-assistant/writing";
import type {WritingGateway} from "../gateway";
import {createExclusiveWritingGateway} from "../gateway/exclusiveWritingGateway";
import {WritingFileSessions} from "../editor/writingFileSessions";
import {WritingCheckpointPersistence} from "../persistence/WritingCheckpointPersistence";
import {WritingFileSaveQueue} from "../persistence/WritingFileSaveQueue";
import {getWritingCheckpointGateway} from "../gateway/writingCheckpointGateway";
import {WritingCitationKeys} from "./WritingCitationKeys";

function entry(id: string, key: string): ProjectBibliographyEntry {
  return {id, manuscriptId:"m", citationKey:key, baseKey:key, originalKey:key, originalBibtex:"", bibtexEntry:"",
    imported:emptyLiteratureDraft(), current:emptyLiteratureDraft(), libraryItem:null, paths:[]};
}
function fixture(initial: readonly ProjectBibliographyEntry[]) {
  let entries = initial;
  // Any path needing source usage is observable before it can mutate a file.
  const usageFailure = Object.assign(new Error("Synthetic usage failure"), {code:"writing_file_missing"});
  const list = vi.fn(async (_id: string, includeUnusedAutomatic = false) => {
    if (!includeUnusedAutomatic) throw usageFailure;
    return entries;
  });
  const source = {listBibliographyEntries:list} as unknown as WritingGateway;
  const access = createExclusiveWritingGateway(source), sessions = new WritingFileSessions();
  const checkpoints = new WritingCheckpointPersistence(sessions,getWritingCheckpointGateway(),reason => {throw reason;});
  const saves = new WritingFileSaveQueue(sessions,checkpoints,access.gateway,reason => {throw reason;});
  const busy = vi.fn(), manager = new WritingCitationKeys(access,sessions,checkpoints,saves,busy);
  return {list,manager,usageFailure,busy,sessions,access,setEntries: (value: readonly ProjectBibliographyEntry[]) => {entries = value;}};
}

it("does not read source usage for any subset of independently stable keys, even with pending identities",async () => {
  const libraryItem: LiteratureItem = {...emptyLiteratureDraft(),id:"library-A",readingStatus:"unread",attachments:[],
    projectIds:[],metadataSources:[],createdAt:"now",updatedAt:"now"};
  const entries = [{...entry("binding:A","xu2026vision"),libraryItem},entry("B","literal:a"),entry("C","z".repeat(128))];
  const f = fixture(entries);
  for (let mask = 0; mask < 2 ** entries.length; mask++) {
    const active = new Set(entries.filter((_,index) => mask & (1 << index)).map(row => row.id));
    // Check the actual planner for every possible saved-source usage set.
    expect(planCitationKeys(entries,active).every((row,index) => row.from === row.to && row.baseKey === entries[index]?.baseKey)).toBe(true);
    expect(await f.manager.reconcile("m",[libraryItem.id])).toBe(false);
  }
  expect(f.list).toHaveBeenCalledTimes(8);
  expect(f.list.mock.calls.every(([,all]) => all)).toBe(true);
  expect(f.busy).not.toHaveBeenCalled();expect(f.sessions.forManuscript("m")).toEqual([]);
});

it("checks fresh metadata on every call and does not cache away a new colliding binding",async () => {
  const first = entry("A","xu2026vision"), f = fixture([first]);
  expect(await f.manager.reconcile("m")).toBe(false);
  f.setEntries([{...first,current:{...first.current,title:"Updated metadata"}}]);
  expect(await f.manager.reconcile("m")).toBe(false);
  f.setEntries([first,{...entry("B","xu2026vision2"),baseKey:"xu2026vision"}]);
  await expect(f.manager.reconcile("m",["B"])).rejects.toBe(f.usageFailure);
  expect(f.list.mock.calls).toEqual([["m",true],["m",true],["m",true],["m"]]);
  // No fulfilled or rejected result survives as a cache entry.
  f.setEntries([first]);expect(await f.manager.reconcile("m")).toBe(false);
});

it.each([
  ["legacy spelling",[{...entry("A","Xu2026Vision"),baseKey:"Xu2026Vision"}]],
  ["missing saved base",[{...entry("A","xu2026vision"),baseKey:undefined}]],
  ["inactive suffix identity",[{...entry("A","xu2026vision:a"),baseKey:"xu2026vision"}]],
  ["colliding family",[{...entry("A","xu2026vision:a"),baseKey:"xu2026vision"},{...entry("B","xu2026vision:b"),baseKey:"xu2026vision"}]],
] as const)("retains source verification and its original error for %s",async (_name,entries) => {
  const f = fixture(entries.map(({baseKey,...row}) => baseKey === undefined ? row : {...row,baseKey}));
  await expect(f.manager.reconcile("m")).rejects.toBe(f.usageFailure);
  await expect(f.manager.reconcile("m")).rejects.toBe(f.usageFailure);
  expect(f.list.mock.calls).toEqual([["m",true],["m"],["m",true],["m"]]);
});

it("still refuses ambiguous old identities before attempting source-dependent work",async () => {
  const f = fixture([entry("A","duplicate"),entry("B","duplicate")]);
  await expect(f.manager.reconcile("m")).rejects.toThrow("无法确定旧引用归属");
  expect(f.list).toHaveBeenCalledExactlyOnceWith("m",true);expect(f.busy).not.toHaveBeenCalled();
});

it("performs no query under the existing exclusive lease and retries after release",async () => {
  const f = fixture([entry("A","single")]), release = await f.access.acquire();
  expect(await f.manager.reconcile("m")).toBe(false);expect(f.list).not.toHaveBeenCalled();
  release();expect(await f.manager.reconcile("m")).toBe(false);
  expect(f.list).toHaveBeenCalledExactlyOnceWith("m",true);
});
