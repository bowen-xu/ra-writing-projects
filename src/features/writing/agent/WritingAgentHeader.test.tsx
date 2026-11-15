/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WritingAgentPanel } from "../../../../../../apps/web/src/core/features/agent/presentation/WritingAgentPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("shows the conversation name independently of files and leaves an unnamed conversation blank", async () => {
  const render = (title?: string, path = "main.tex") => root.render(<WritingAgentPanel open activePath={path} {...(title ? { conversationTitle: title } : {})} />);
  const title = () => host.querySelector(".writing-agent-header-subtitle")?.textContent;
  await act(async () => render("讨论研究问题"));
  expect(title()).toBe("讨论研究问题");
  await act(async () => render("讨论研究问题", "appendix.tex"));
  expect(title()).toBe("讨论研究问题");
  await act(async () => render("修订后的会话名称"));
  expect(title()).toBe("修订后的会话名称");
  await act(async () => render());
  expect(title()).toBe("");
});
it("uses Escape to cancel a layout drag without stopping the Agent or replacing its draft", async () => {
  const onCancel = vi.fn(), onOpenChange = vi.fn();
  await act(async () => root.render(<WritingAgentPanel open isRunning draft="保留草稿" onCancel={onCancel} onOpenChange={onOpenChange} />));
  const panel = host.querySelector<HTMLElement>(".writing-agent-panel")!;
  const handle = host.querySelector<HTMLButtonElement>('[aria-label="拖动切换聊天布局"]')!;
  const input = host.querySelector("textarea")!;
  await act(async () => handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 500 })));
  expect(panel.dataset.dragging).toBe("true");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
  expect(panel.dataset.dragging).toBe("false");
  expect(onCancel).not.toHaveBeenCalled(); expect(onOpenChange).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")).toBe(input); expect(input.value).toBe("保留草稿");
});
it("hides the panel without interrupting its turn and has no adapter-specific close control", async () => {
  const onCancel = vi.fn(), onOpenChange = vi.fn();
  await act(async () => root.render(<WritingAgentPanel open isRunning conversationTitle="讨论实验设计" onCancel={onCancel} onOpenChange={onOpenChange} />));
  expect(host.querySelector('[aria-label="关闭当前对话"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="隐藏 AI 写作助手"]')!.click());
  expect(onOpenChange).toHaveBeenCalledWith(false); expect(onCancel).not.toHaveBeenCalled();
});
