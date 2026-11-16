/** @vitest-environment happy-dom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WritingWorkspaceReview } from "@research-assistant/writing-projects-preview/writing-workspace-review";
const gateway = vi.hoisted(() => ({find:vi.fn(),preview:vi.fn(),discard:vi.fn(),success:vi.fn()}));
vi.mock("@research-assistant/workbench-preview/agent-gateway", () => ({agentWorkspaceDiscardGateway:gateway}));
vi.mock("@research-assistant/workbench-preview/notifications", () => ({notify:{success:gateway.success}}));
const id = "11111111-1111-4111-8111-111111111111";
const scope = {conversationId:id,requestId:id,manuscriptId:id,contextSnapshotId:id};
const binding = {scope,turnId:id,leaseId:id,manifestHash:"a".repeat(64)};
const confirmation = {operationId:id,binding,environmentId:`manuscript:${id}`,inventoryHash:"b".repeat(64)};
const version = {sha256:"c".repeat(64),byteSize:3,executable:false};
const preview = {schemaVersion:1,confirmation,review:{schemaVersion:1,binding,changes:[{path:"main.tex",kind:"modified",before:version,after:version,hasEditorBuffer:false}]}};
const complete = {...confirmation,schemaVersion:1,state:"complete"};
let root:Root; let container:HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks(); gateway.find.mockResolvedValue(null); gateway.preview.mockResolvedValue(preview); gateway.discard.mockResolvedValue(complete);
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement("div"); document.body.append(container); root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();});
async function render(requestId=id,disabled=false):Promise<void> {
  await act(async () => root.render(<WritingWorkspaceReview key={requestId} scope={{...scope,requestId}} disabled={disabled}/>));
}
async function click(label:string):Promise<void> {
  const button=[...container.querySelectorAll("button")].find(value => value.textContent===label);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
it("previews only after opening and keeps files without a cleanup call", async () => {
  await render(); expect(gateway.find).not.toHaveBeenCalled();
  await click("管理执行副本"); expect(container.querySelector("dialog")?.open).toBe(true);
  expect(container.textContent).toContain("main.tex"); expect(gateway.discard).not.toHaveBeenCalled();
  await click("保留副本"); expect(container.querySelector("dialog")).toBeNull();
  expect(document.activeElement?.textContent).toBe("管理执行副本"); expect(gateway.discard).not.toHaveBeenCalled();
});
it("settles the current preview under the application's StrictMode effect replay", async () => {
  await act(async () => root.render(<StrictMode><WritingWorkspaceReview scope={scope} disabled={false}/></StrictMode>));
  await click("管理执行副本");
  expect(container.textContent).toContain("main.tex");
  expect(container.textContent).not.toContain("正在核对副本与清理记录");
  expect(gateway.preview).toHaveBeenCalledOnce();
  expect(gateway.discard).not.toHaveBeenCalled();
  await click("确认丢弃副本"); expect(gateway.discard).toHaveBeenCalledExactlyOnceWith(confirmation);
});
it("confirms once and reports completion only after the native response", async () => {
  let finish!: (value:unknown) => void; gateway.discard.mockReturnValueOnce(new Promise(done => {finish=done;}));
  await render(); await click("管理执行副本"); await click("确认丢弃副本"); await click("正在丢弃…");
  expect(gateway.discard).toHaveBeenCalledExactlyOnceWith(confirmation); expect(gateway.success).not.toHaveBeenCalled();
  expect(container.textContent).toContain("关闭窗口后清理仍会继续");
  await act(async () => finish(complete)); expect(gateway.success).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("清理记录显示已完成");
});
it("reopens pending intent without reading partially removed files or creating a new operation", async () => {
  gateway.find.mockResolvedValue({...complete,state:"pending"});
  await render(); await click("管理执行副本");
  expect(gateway.preview).not.toHaveBeenCalled(); expect(container.textContent).toContain("部分文件可能已移除");
  await click("暂不继续"); expect(gateway.discard).not.toHaveBeenCalled();
  await click("管理执行副本"); await click("重试原清理");
  expect(gateway.discard).toHaveBeenCalledExactlyOnceWith(confirmation);
});
it("retains an uncertain operation across refresh and does not hide lookup failures as absence", async () => {
  await render(); await click("管理执行副本"); gateway.discard.mockRejectedValueOnce(new Error("transport"));
  await click("确认丢弃副本"); expect(container.textContent).toContain("尚未确认");
  await click("刷新清理状态"); expect(gateway.preview).toHaveBeenCalledTimes(1);
  await click("重试原清理"); expect(gateway.discard).toHaveBeenNthCalledWith(2,confirmation);
  await click("关闭"); gateway.find.mockRejectedValueOnce(new Error("unavailable"));
  await click("管理执行副本"); expect(container.textContent).toContain("无法核对副本状态");
  expect(gateway.preview).toHaveBeenCalledTimes(1);
});
it("rechecks an explicit native conflict before accepting a new inventory", async () => {
  await render(); await click("管理执行副本"); gateway.discard.mockRejectedValueOnce("conflict");
  await click("确认丢弃副本"); expect(container.textContent).toContain("确认版本已变化");
  expect([...container.querySelectorAll("button")].some(value => value.textContent==="重试原清理")).toBe(false);
  const changed={...confirmation,inventoryHash:"d".repeat(64)};
  gateway.preview.mockResolvedValueOnce({...preview,confirmation:changed});
  await click("刷新清理状态"); await click("确认丢弃副本");
  expect(gateway.discard).toHaveBeenNthCalledWith(2,changed);
});
it("disables confirmation during activity and drops late results when switching submissions", async () => {
  await render(); await click("管理执行副本"); await render(id,true);
  await click("确认丢弃副本"); expect(gateway.discard).not.toHaveBeenCalled();
  await render(); let finish!: (value:unknown) => void;
  gateway.discard.mockReturnValueOnce(new Promise(done => {finish=done;})); await click("确认丢弃副本");
  await render("22222222-2222-4222-8222-222222222222"); await act(async () => finish(complete));
  expect(gateway.success).not.toHaveBeenCalled(); expect(container.querySelector("dialog")).toBeNull();
});
it("ignores preview completion after closing and supports Esc focus return", async () => {
  let finish!: (value:unknown) => void; gateway.preview.mockReturnValueOnce(new Promise(done => {finish=done;}));
  await render(); await click("管理执行副本");
  await act(async () => container.querySelector("dialog")?.dispatchEvent(new Event("cancel",{bubbles:true,cancelable:true})));
  await act(async () => finish(preview)); expect(container.querySelector("dialog")).toBeNull();
  expect(gateway.discard).not.toHaveBeenCalled(); expect(document.activeElement?.textContent).toBe("管理执行副本");
});
