// @vitest-environment happy-dom
import { act as reactAct, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WritingMenu, WritingMenuItem } from "./WritingMenu";
import { WritingToolbar } from "./WritingToolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.each(["保存当前文件", "导入目录", "导入 ZIP", "上传资源", "命令面板"])(
  "%s survives WebKit null-target blur and runs once before closing the file menu", async (label) => {
    const action = vi.fn();
    await act(async () => root.render(<WritingToolbar activeManuscript={undefined} saveState="saved"
      onSave={action} onOpenCommands={action} onSettings={vi.fn()}
      onRename={vi.fn()} projectActions={null} viewMode="split" onViewModeChange={vi.fn()}
      focused={false} onToggleFocus={vi.fn()} transferActions={<>
        {["导入目录", "导入 ZIP", "上传资源"].map((text) => <WritingMenuItem key={text} type="button" onClick={action}>{text}</WritingMenuItem>)}
      </>} />));
    const menu = host.querySelector<HTMLElement>(".writing-menu")!;
    await act(async () => menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
    await act(async () => menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus());
    await act(async () => document.activeElement?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })));
    expect(menu.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((item) => item.textContent === label)?.click());
    expect(action).toHaveBeenCalledTimes(1);
    expect(menu.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]'));
  },
);

it("dismisses on actual outside focus or pointer, navigates enabled items, and restores focus on Escape", async () => {
  await act(async () => root.render(<><WritingMenu label="操作" trigger="操作" className="test-menu">
    <WritingMenuItem type="button">首项</WritingMenuItem><WritingMenuItem type="button" disabled>禁用</WritingMenuItem><WritingMenuItem type="button">末项</WritingMenuItem>
  </WritingMenu><WritingMenuItem type="button" id="outside">外部</WritingMenuItem></>));
  const menu = host.querySelector<HTMLElement>(".test-menu")!;
  const trigger = menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  const key = async (value: string): Promise<void> => { await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))); };
  await act(async () => trigger.focus()); await key("ArrowUp");
  expect(document.activeElement?.textContent).toBe("末项");
  await key("Home"); await key("ArrowDown");
  expect(document.activeElement?.textContent).toBe("末项");
  await key("Escape"); expect(menu.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(trigger);
  await act(async () => menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
  await act(async () => host.querySelector<HTMLButtonElement>("#outside")?.focus());
  expect(menu.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(menu.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("false");
});

it("keeps action-owned portal input focus after the menu closes", async () => {
  function Harness(): React.JSX.Element {
    const [editing, setEditing] = useState(false);
    return <WritingMenu label="操作" trigger="操作" className="test-menu">
      <WritingMenuItem type="button" onClick={() => setEditing(true)}>编辑</WritingMenuItem>
      {editing && createPortal(<div><input autoFocus aria-label="编辑名称" /><button type="button">弹窗按钮</button></div>, document.body)}
    </WritingMenu>;
  }
  await act(async () => root.render(<Harness />));
  const menu = host.querySelector<HTMLElement>(".test-menu")!;
  await act(async () => menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click()); menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click());
  expect(document.activeElement?.getAttribute("aria-label")).toBe("编辑名称");
  expect(menu.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("false");
});

async function act(callback: () => unknown): Promise<void> {
  await reactAct(async () => { await callback(); });
  await reactAct(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
}
