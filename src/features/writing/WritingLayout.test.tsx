// @vitest-environment happy-dom
import { act as reactAct, type KeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WritingLayoutMenu } from "./WritingLayoutMenu";
import { WritingDivider } from "./WritingDivider";
import { useWritingLayout } from "./useWritingLayout";
import { handleWritingLayoutShortcut, writingLayoutAction } from "./writingLayoutShortcuts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
async function mount(node: React.ReactNode): Promise<void> { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root?.render(node)); }

it("opens a navigable layout menu and returns focus after selection and Escape", async () => {
  const onMode = vi.fn();
  await mount(<WritingLayoutMenu mode="split" focused={false} onMode={onMode} onFocus={vi.fn()} />);
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  await act(async () => document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement?.textContent).toContain("仅源码");
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(onMode).toHaveBeenCalledWith("editor");
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true);
  expect(document.activeElement).toBe(trigger);
});

it("restores the exact pre-focus layout and never persists temporary focus changes", async () => {
  let layout!: ReturnType<typeof useWritingLayout>;
  function Harness() { layout = useWritingLayout(); return null; }
  await mount(<Harness />);
  await act(async () => layout.restore({ viewMode: "preview", explorerWidth: 300, previewWidth: 600, narrowPane: "preview", explorerVisible: false }));
  const before = layout.preferences;
  await act(async () => layout.toggleFocus());
  await act(async () => layout.setViewMode("editor"));
  expect(layout.focused).toBe(true);
  expect(layout.preferences.viewMode).toBe("editor");
  expect(layout.persistenceState).toEqual({...before, focused: true});
  const saved = JSON.parse(JSON.stringify(layout.persistenceState)) as unknown;
  await act(async () => layout.restore(saved));
  expect(layout.focused).toBe(true);
  expect(layout.preferences).toEqual(before);
  await act(async () => layout.toggleFocus());
  expect(layout.preferences).toEqual(before);
  await act(async () => layout.toggleExplorer());
  expect(layout.preferences.explorerWidth).toBe(300);
  await act(async () => layout.keyResize("explorer", { key: "ArrowRight", shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLDivElement>));
  expect(layout.preferences.explorerWidth).toBe(316);
  await act(async () => layout.keyResize("preview", { key: "Home", preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLDivElement>));
  expect(layout.preferences.previewWidth).toBe(280);
  await act(async () => layout.toggleFocus());
  await act(async () => layout.restore({}));
  expect(layout.focused).toBe(false);
});

it("accepts layout mouse clicks after WebKit loses button focus", async () => {
  const onMode = vi.fn();
  await mount(<WritingLayoutMenu mode="split" focused={false} onMode={onMode} onFocus={vi.fn()} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  const pdf = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[2]!;
  await act(async () => {
    pdf.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    document.activeElement?.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  });
  expect(pdf.isConnected).toBe(true);
  await act(async () => pdf.click());
  expect(onMode).toHaveBeenCalledWith("preview");
});

it("separates divider folding from dragging", async () => {
  const toggle = vi.fn(); const resize = vi.fn();
  await mount(<WritingDivider edge="explorer" collapsed={false} direction="left" label="收起文件树" width={220} onToggle={toggle} onResize={resize} onKeyResize={vi.fn()} />);
  await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
  expect(toggle).toHaveBeenCalledOnce(); expect(resize).not.toHaveBeenCalled();
  await act(async () => document.querySelector('[role="separator"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })));
  expect(resize).toHaveBeenCalledOnce();
});

it("bounds a drag and stops resizing after pointer release", async () => {
  let layout!: ReturnType<typeof useWritingLayout>;
  function Harness() {
    layout = useWritingLayout();
    return <WritingDivider edge="explorer" collapsed={false} direction="left" label="收起文件树" width={layout.preferences.explorerWidth} onToggle={layout.toggleExplorer} onResize={(event) => layout.startResize("explorer", event)} onKeyResize={(event) => layout.keyResize("explorer", event)} />;
  }
  await mount(<Harness />);
  await act(async () => document.querySelector('[role="separator"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, clientX: 220 })));
  await act(async () => window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 270 })));
  expect(layout.preferences.explorerWidth).toBe(270);
  await act(async () => window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 1000 })));
  expect(layout.preferences.explorerWidth).toBe(380);
  await act(async () => window.dispatchEvent(new window.PointerEvent("pointerup")));
  await act(async () => window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 0 })));
  expect(layout.preferences.explorerWidth).toBe(380);
});

describe("layout shortcuts", () => {
  const key = { key: "ArrowLeft", metaKey: true, ctrlKey: true, shiftKey: false, altKey: false };
  it("uses the documented macOS layout chord without inventing Windows bindings", () => {
    expect(writingLayoutAction(key, true)).toBe("editor");
    expect(writingLayoutAction(key, false)).toBeUndefined();
    expect(writingLayoutAction({ ...key, key: "M", ctrlKey: false, shiftKey: true }, true)).toBe("focus");
    expect(writingLayoutAction({ ...key, key: "M", metaKey: false, shiftKey: true }, false)).toBe("focus");
  });
  it("does not steal keys from a modal or IME", () => {
    const onMode = vi.fn(); const onFocus = vi.fn();
    const event = { ...key, nativeEvent: { isComposing: true }, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    handleWritingLayoutShortcut(event, onMode, onFocus);
    const dialog = document.createElement("dialog"); dialog.setAttribute("open", ""); document.body.append(dialog);
    handleWritingLayoutShortcut({ ...event, nativeEvent: { isComposing: false } } as KeyboardEvent, onMode, onFocus);
    expect(onMode).not.toHaveBeenCalled(); expect(onFocus).not.toHaveBeenCalled();
  });
  it("leaves text controls to their own editing shortcuts", () => {
    const onMode = vi.fn(); const onFocus = vi.fn();
    const input = document.createElement("textarea"); document.body.append(input);
    const event = { ...key, target: input, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    handleWritingLayoutShortcut(event, onMode, onFocus);
    expect(onMode).not.toHaveBeenCalled(); expect(onFocus).not.toHaveBeenCalled();
  });
});



async function act(callback: () => unknown): Promise<void> {
  await reactAct(async () => { await callback(); });
  await reactAct(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
}

it("clamps preview state to the visible grid limit and reverses immediately after overshooting", async () => {
  let layout!: ReturnType<typeof useWritingLayout>;
  function Harness() {
    layout = useWritingLayout();
    return <div className="writing-grid"><WritingDivider edge="preview" collapsed={false} direction="right" label="收起 PDF" width={layout.preferences.previewWidth} onToggle={vi.fn()} onResize={event => layout.startResize("preview", event)} onKeyResize={event => layout.keyResize("preview", event)} /></div>;
  }
  await mount(<Harness />);
  const grid = document.querySelector<HTMLElement>(".writing-grid")!;
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
  const divider = document.querySelector<HTMLElement>('[role="separator"]')!;
  await act(() => layout.restore({ previewWidth: 720 }));
  await act(() => divider.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, clientX: 600 })));
  expect(layout.preferences.previewWidth).toBe(430);
  await act(() => window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: -1000 })));
  expect(layout.preferences.previewWidth).toBe(430);
  expect(layout.persistenceState.previewWidth).toBe(430);
  await act(() => window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: -990 })));
  expect(layout.preferences.previewWidth).toBe(420);
  await act(() => window.dispatchEvent(new window.PointerEvent("pointerup")));
  await act(() => divider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(layout.preferences.previewWidth).toBe(430);
  grid.dataset.explorerVisible = "false";
  await act(() => divider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(layout.preferences.previewWidth).toBe(500);
});
