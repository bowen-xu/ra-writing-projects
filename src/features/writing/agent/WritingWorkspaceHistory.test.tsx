/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WritingWorkspaceHistory } from "./WritingWorkspaceHistory";
const gateway = vi.hoisted(() => ({ list:vi.fn(), review:vi.fn(), readFile:vi.fn(),latest:vi.fn() }));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", () => ({agentWorkspaceReviewGateway:gateway,agentProposalGateway:gateway}));
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const scope = {conversationId:id,manuscriptId:id,requestId:id,contextSnapshotId:id};
const page = {schemaVersion:1,entries:[{scope,turnId:id,createdAt:"2026-09-09T00:00:00.000Z"}],nextCursor:id};
let root:Root; let container:HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks(); gateway.latest.mockResolvedValue(null);
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement("div"); document.body.append(container); root=createRoot(container);
  gateway.list.mockResolvedValue(page);
  gateway.review.mockResolvedValue({schemaVersion:1,binding:{scope,turnId:id,leaseId:id,manifestHash:"a".repeat(64)},changes:[]});
});
afterEach(async () => {await act(async () => root.unmount());container.remove();});
async function render(conversationId=id,disabled=false):Promise<void> {
  await act(async () => root.render(<WritingWorkspaceHistory key={conversationId} conversationId={conversationId} manuscriptId={id} turnOrder={[id]} disabled={disabled}/>));
}
async function click(label:string):Promise<void> {
  const button=[...container.querySelectorAll("button")].find((button)=>button.textContent===label);
  if(!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
it("discovers history without a current preview, opens its exact scope, and paginates",async () => {
  await render(); expect(gateway.list).not.toHaveBeenCalled();
  await click("历史副本变更");
  expect(gateway.list).toHaveBeenLastCalledWith({conversationId:id,manuscriptId:id,cursor:null,limit:20});
  await click("查看第 1 轮副本变更"); expect(gateway.review).toHaveBeenCalledWith(scope);
  expect(container.querySelector("dialog")).toBeNull();
  await click("查看第 1 轮副本变更");
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "查看第 1 轮副本变更")?.getAttribute("aria-expanded")).toBe("false");
  gateway.list.mockResolvedValueOnce({schemaVersion:1,entries:[],nextCursor:null});
  await click("下一页"); expect(gateway.list).toHaveBeenLastCalledWith({conversationId:id,manuscriptId:id,cursor:id,limit:20});
  expect(container.textContent).toContain("本页没有副本记录");
  await click("返回第一页"); expect(container.textContent).toContain("第 1 轮");
  await render(other); expect(container.textContent).not.toContain("第 1 轮");
});
it("ignores late results after closing or scope changes and reloads after running",async () => {
  let finish!:(value:unknown)=>void;
  gateway.list.mockReturnValueOnce(new Promise((resolve)=>{finish=resolve;}));
  await render(); await click("历史副本变更"); await click("历史副本变更");
  await act(async()=>finish(page)); expect(container.textContent).not.toContain("第 1 轮");
  await render(id,true); await click("历史副本变更"); expect(gateway.list).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("请先处理");
  await render(id,false); expect(gateway.list).toHaveBeenCalledTimes(2); expect(container.textContent).toContain("第 1 轮");
  gateway.list.mockRejectedValueOnce(new Error("offline")); await click("刷新副本列表");
  expect(container.textContent).toContain("读取失败"); expect(container.textContent).not.toContain("第 1 轮");
  await click("刷新副本列表"); expect(container.textContent).toContain("第 1 轮");
  gateway.list.mockReturnValueOnce(new Promise((resolve)=>{finish=resolve;}));
  await click("刷新副本列表"); await render(other);
  await act(async()=>finish(page)); expect(container.textContent).not.toContain("第 1 轮");
});
