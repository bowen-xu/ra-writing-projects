// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createWritingNote } from "@research-assistant/writing";
import { WritingNoteToolbar } from "./WritingNoteToolbar";

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
it("shares note controls without allowing attached favorites and invokes real file actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), onSave = vi.fn(), onRename = vi.fn(), onDelete = vi.fn();
  const props = { manuscriptId: "project", path: "notes/plan.ranote", content: JSON.stringify(createWritingNote("stable-note", "block")), saveState: "dirty" as const, onSave, onRename, onDelete };
  const legacyKey = 'research-assistant.writing.note-favorite:["project","stable-note"]';
  localStorage.setItem(legacyKey, "true");
  const find = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    await act(async () => root.render(<WritingNoteToolbar {...props} />));
    expect(host.querySelector('[role="toolbar"][aria-label="笔记页面操作"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toContain("等待保存");
    expect(find("收藏页面")).toBeNull();
    expect(find("取消收藏")).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBe("true");
    await act(async () => root.render(<WritingNoteToolbar {...props} path="notes/renamed.ranote" saveState="saved" />));
    expect(find("取消收藏")).toBeNull();
    await act(async () => find("页面属性").click());
    expect(host.querySelector('section[aria-label="页面属性"]')?.textContent).toContain("notes/renamed.ranote");
    await act(async () => find("更多页面操作").click());
    const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!;
    await act(async () => menuItem("保存笔记").click());
    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => find("更多页面操作").click());
    await act(async () => menuItem("重命名").click());
    const input = host.querySelector<HTMLInputElement>('[aria-label="重命名笔记"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "next"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onRename).toHaveBeenCalledWith("notes/renamed.ranote", "notes/next.ranote");
    await act(async () => find("更多页面操作").click());
    await act(async () => menuItem("删除笔记").click());
    expect(onDelete).toHaveBeenCalledWith("notes/renamed.ranote");
    await act(async () => root.render(<WritingNoteToolbar {...props} manuscriptId="other" />));
    expect(find("收藏页面")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
