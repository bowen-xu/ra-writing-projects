// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useWritingSourceNavigation } from "@research-assistant/writing-projects-preview/use-writing-source-navigation";
import type { WritingSourceNavigation } from "@research-assistant/workbench-preview/use-source-navigation-host";
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
it("retains navigation during the file loading state and drops superseded requests", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host);
  cleanups.push(() => act(() => root.unmount()));
  let finish!: (success: boolean) => void;
  const select = vi.fn(() => new Promise<boolean>(resolve => {finish = resolve;})), focus = vi.fn();
  const request: WritingSourceNavigation = {manuscriptId: "project", path: "a.tex", token: 1, locator: {kind: "line", range: {startLine: 1, startColumn: 1, endLine: 1, endColumn: 3}}, resolve: vi.fn(), reject: vi.fn()};
  function Harness({ready, request}: {ready: boolean; request?: WritingSourceNavigation | undefined}) { useWritingSourceNavigation(request, "project", ready, select, focus); return null; }
  await act(async () => root.render(<Harness ready request={request} />));
  await act(async () => root.render(<Harness ready={false} request={request} />));
  await act(async () => finish(true));
  expect(focus).toHaveBeenCalledOnce();
  expect(focus.mock.calls[0]![0].path).toBe("a.tex");
  await act(async () => root.render(<Harness ready request={{...request, token: 2}} />));
  await act(async () => root.render(<Harness ready />));
  await act(async () => finish(true));
  expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({message: "来源导航已被新请求取代"}));
  expect(focus).toHaveBeenCalledOnce();
});
it("opens ordinary whole files without a text editor acknowledgment, but locates an annotation editor at line one",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div"),root=createRoot(host);cleanups.push(()=>act(()=>root.unmount()));
  const select=vi.fn(async()=>true),focus=vi.fn(),resolve=vi.fn(),reject=vi.fn();
  const request:WritingSourceNavigation={manuscriptId:"project",path:"a.tex",token:3,resolve,reject};
  function Harness({request}:{request:WritingSourceNavigation}){useWritingSourceNavigation(request,"project",true,select,focus);return null;}
  await act(async()=>root.render(<Harness request={request}/>));expect(resolve).toHaveBeenCalledOnce();expect(focus).not.toHaveBeenCalled();
  await act(async()=>root.render(<Harness request={{...request,token:4,locate:true}}/>));expect(focus).toHaveBeenCalledWith(expect.objectContaining({line:1,onLocated:resolve}));
  expect(resolve).toHaveBeenCalledOnce();expect(reject).not.toHaveBeenCalled();
});

it("passes writing-note block identity to the same note surface navigation contract", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host); cleanups.push(() => act(() => root.unmount()));
  const focus = vi.fn(), resolve = vi.fn(), reject = vi.fn(), select = vi.fn(async () => true);
  const request: WritingSourceNavigation = {manuscriptId: "project", path: "notes/idea.ranote", token: 5,
    locator: {kind: "block", blockId: "stable-block"}, resolve, reject};
  function Harness() {useWritingSourceNavigation(request, "project", true, select, focus); return null;}
  await act(async () => root.render(<Harness/>));
  expect(focus).toHaveBeenCalledWith(expect.objectContaining({path: request.path, blockId: "stable-block", onLocated: resolve, onError: reject}));
  expect(resolve).not.toHaveBeenCalled(); expect(reject).not.toHaveBeenCalled();
});
