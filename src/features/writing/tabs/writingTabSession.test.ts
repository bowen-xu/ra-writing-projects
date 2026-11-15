// @vitest-environment happy-dom
import {beforeEach,expect,it} from "vitest";
import {selectAppStorage} from "../../../../../../apps/web/src/core/runtime/appStorage";
import {writeWorkspaceState} from "../../../../../../apps/web/src/core/runtime/workspaceState";
import {WritingProjectTabs} from "./WritingProjectTabs";
import {decodeWritingTabs,loadWritingTabs} from "./writingTabSession";
beforeEach(()=>{localStorage.clear();selectAppStorage(localStorage);});
it("restores multiple projects, file disposition, cursor and layout while respecting explicit closed-all state",()=>{
  const store=new WritingProjectTabs();
  for(const id of ["one","two"])store.sync({manuscriptId:id,openPaths:["main.tex","intro.tex"],activePath:"intro.tex",cursorState:{"intro.tex":22},layoutState:{explorerVisible:false,previewWidth:500}});
  store.close("two","main.tex");store.close("two","intro.tex");
  writeWorkspaceState("writing-projects",store.getSnapshot());
  const reopened=new WritingProjectTabs(loadWritingTabs());
  expect(reopened.getSnapshot()).toEqual(store.getSnapshot());
  expect(reopened.get("two")?.openPaths).toEqual([]);
  const open=reopened.prepareOpen("one","main.tex","preview");open();
  expect(reopened.get("one")?.previewPath).toBeUndefined();
});
it("rejects traversal paths, duplicates and malformed project descriptors",()=>{
  const rows=decodeWritingTabs([{manuscriptId:"p",openPaths:["main.tex","../outside","main.tex"],activePath:"../outside",cursorState:{a:NaN}},{manuscriptId:"p",openPaths:[]},null]);
  expect(rows).toHaveLength(1);expect(rows[0]?.openPaths).toEqual(["main.tex"]);expect(rows[0]?.activePath).toBeUndefined();expect(rows[0]?.cursorState).toEqual({});
});
