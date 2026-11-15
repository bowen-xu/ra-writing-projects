import { WritingMenuItem } from "./WritingMenu";
// @vitest-environment happy-dom
import { act as reactAct } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Manuscript } from "@research-assistant/writing";
import { WritingProjectMenu } from "./WritingProjectMenu";
import type { ManuscriptGitBranches } from "../../public/contracts/gitVersionGateway";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function mount(rename: (title: string) => Promise<boolean>) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  await act(async () => root.render(<WritingProjectMenu manuscript={{ id: "test", title: "Original title", status: "active" } as Manuscript} onRename={rename} exports={<><WritingMenuItem role="menuitem" disabled>下载 PDF</WritingMenuItem><WritingMenuItem role="menuitem">下载源码（.zip）</WritingMenuItem></>} />));
  return document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
}
it("navigates title actions, skips disabled exports, and returns focus on Escape", async () => {
  const trigger = await mount(vi.fn(async () => true));
  await act(async () => trigger.click());
  expect(document.activeElement?.textContent).toContain("zip");
  await act(async () => document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement?.textContent).toBe("重命名稿件");
  await act(async () => document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true);
  expect(document.activeElement).toBe(trigger);
});
it("prefills rename, prevents duplicate submissions, and keeps failed edits open", async () => {
  let finish!: (success: boolean) => void;
  const rename = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const trigger = await mount(rename);
  await act(async () => trigger.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === "重命名稿件")!.click());
  expect(document.querySelector<HTMLInputElement>("dialog input")?.value).toBe("Original title");
  const submit = () => document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await act(async () => { submit(); });
  await act(async () => { submit(); });
  expect(rename).toHaveBeenCalledOnce();
  await act(async () => finish(false));
  expect(document.querySelector("dialog[open]")).not.toBeNull();
  await act(async () => { submit(); });
  await act(async () => finish(true));
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("keeps mouse actions available after WebKit blurs without a new focus target", async () => {
  const trigger = await mount(vi.fn(async () => true));
  await act(async () => trigger.click());
  const rename = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === "重命名稿件")!;
  await act(async () => {
    rename.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    document.activeElement?.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  });
  expect(document.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(false);
  await act(async () => rename.click());
  expect(document.querySelector("dialog[open] input")).not.toBeNull();
});

it("dismisses when focus moves outside", async () => {
  const trigger = await mount(vi.fn(async () => true));
  const outside = document.createElement("button"); document.body.append(outside);
  await act(async () => trigger.click());
  await act(async () => outside.focus());
  expect(document.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true);
});

it("closes after choosing an export and returns focus to the title", async () => {
  const trigger = await mount(vi.fn(async () => true));
  await act(async () => trigger.click());
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(document.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true);
  expect(document.activeElement).toBe(trigger);
});

it("lists and exposes guarded Git version actions", async () => {
  const list = vi.fn(async () => [{ sha: "a".repeat(40), timestampUnixSeconds: 1, subject: "Initial" }]);
  const create = vi.fn(async () => ({ sha: "b".repeat(40), timestampUnixSeconds: 2, subject: "Saved" }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<WritingProjectMenu manuscript={{ id: "test", title: "Original title", status: "active" } as Manuscript}
    onRename={vi.fn(async () => true)} onListVersions={list} onCreateVersion={create} exports={null} />));
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "查看 Git 版本")?.click());
  expect(list).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"][aria-label="Git 版本历史"]')?.textContent).toContain("Initial");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"][aria-label="Git 版本历史"] button')?.click());
  await act(async () => trigger.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "创建 Git 版本")?.click());
  expect(create).toHaveBeenCalledOnce();
});

it("initializes manuscript Git only from an explicit title-menu action", async () => {
  const initialize = vi.fn(async () => undefined);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<WritingProjectMenu manuscript={{ id: "test", title: "Original title", status: "active" } as Manuscript}
    onRename={vi.fn(async () => true)} onInitializeGit={initialize} exports={null} />));
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "初始化 Git 版本管理")?.click());
  expect(initialize).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true);
});

it("opens the Git branch actions from the title menu", async () => {
  const list = vi.fn(async (): Promise<ManuscriptGitBranches> => ({ schemaVersion: 1, manuscriptId: "test", current: "main", branches: ["main", "draft"] }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<WritingProjectMenu manuscript={{ id: "test", title: "Original title", status: "active" } as Manuscript}
    onRename={vi.fn(async () => true)} onListBranches={list} onCreateBranch={vi.fn(async () => undefined)} onDeleteBranch={vi.fn(async () => undefined)} exports={null} />));
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Git 分支")?.click());
  expect(list).toHaveBeenCalledOnce();
  expect(document.querySelector("dialog[open]")?.textContent).toContain("draft");
});

it("exposes historical restore through the existing Git version dialog", async () => {
  const restore = vi.fn(async () => undefined);
  const list = vi.fn(async () => [{ sha: "a".repeat(40), timestampUnixSeconds: 1, subject: "Initial" }]);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<WritingProjectMenu manuscript={{ id: "test", title: "Original title", status: "active" } as Manuscript}
    onRename={vi.fn(async () => true)} onListVersions={list} onRestoreVersion={restore} exports={null} />));
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "查看 Git 版本")?.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Git 版本历史"] button')].find((item) => item.textContent === "恢复为待审变更")?.click());
  expect(restore).toHaveBeenCalledExactlyOnceWith("a".repeat(40));
});

async function act(callback: () => unknown): Promise<void> {
  await reactAct(async () => { await callback(); });
  await reactAct(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
}
