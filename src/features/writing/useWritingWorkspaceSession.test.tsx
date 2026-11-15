// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {beforeEach,expect,it,vi} from "vitest";
import {selectAppStorage} from "../../../../../apps/web/src/core/runtime/appStorage";
import {writeWorkspaceState} from "../../../../../apps/web/src/core/runtime/workspaceState";
import {useWritingLayout} from "./useWritingLayout";
import {useWritingWorkspaceSession} from "./useWritingWorkspaceSession";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
beforeEach(()=>{localStorage.clear();selectAppStorage(localStorage);});

it("restores a selected project only when its workbench is shown, without replacing an explicit open request",async()=>{
  writeWorkspaceState("writing-active","saved-project");
  writeWorkspaceState("writing-visible",true);
  const root=createRoot(document.createElement("div"));
  let session!:ReturnType<typeof useWritingWorkspaceSession>;
  function Harness({visible,openId}:{visible:boolean;openId?:string}) {
    const layout=useWritingLayout();
    session=useWritingWorkspaceSession(openId,layout,undefined,undefined,visible);return null;
  }
  await act(async()=>root.render(<Harness visible={false}/>));
  expect(session.activeManuscriptId).toBeUndefined();
  await act(async()=>root.render(<Harness visible/>));
  expect(session.activeManuscriptId).toBe("saved-project");
  await act(async()=>root.unmount());

  const next=createRoot(document.createElement("div"));
  await act(async()=>next.render(<Harness visible openId="requested-project"/>));
  expect(session.activeManuscriptId).toBeUndefined(); // useRequestedManuscript owns explicit requests.
  await act(async()=>next.unmount());
});

it("keeps the project list as Home across restart without loading the previous project",async()=>{
  writeWorkspaceState("writing-active","saved-project");
  writeWorkspaceState("writing-visible",false);
  const root=createRoot(document.createElement("div"));
  let session!:ReturnType<typeof useWritingWorkspaceSession>;
  function Harness(){session=useWritingWorkspaceSession(undefined,useWritingLayout(),undefined,undefined);return null;}
  await act(async()=>root.render(<Harness/>));
  expect(session.isLibraryOpen).toBe(true);
  expect(session.activeManuscriptId).toBeUndefined();
  await act(async()=>session.setCatalogReady(true));
  expect(session.activeManuscriptId).toBeUndefined();
  await act(async()=>root.unmount());
});

it("does not restore a missing saved project after its catalog finished loading while hidden",async()=>{
  writeWorkspaceState("writing-active","missing-project");
  writeWorkspaceState("writing-visible",true);
  const root=createRoot(document.createElement("div"));
  let session!:ReturnType<typeof useWritingWorkspaceSession>;
  function Harness({visible}:{visible:boolean}) {
    session=useWritingWorkspaceSession(undefined,useWritingLayout(),undefined,undefined,visible);
    return null;
  }
  await act(async()=>root.render(<Harness visible={false}/>));
  await act(async()=>{
    session.setActiveManuscriptId(undefined);
    session.setCatalogReady(true);
  });
  await act(async()=>root.render(<Harness visible/>));
  expect(session.activeManuscriptId).toBeUndefined();
  expect(session.isLibraryOpen).toBe(true);
  await act(async()=>root.unmount());
});
