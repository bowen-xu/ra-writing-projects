/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WritingAgentPanel } from "../../../../../../apps/web/src/core/features/agent/presentation/WritingAgentPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("waits for a message, focuses it once and preserves the composer and draft across streaming updates", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const target = { messageId: "turn/item", requestId: 1 };
  const message = { id: "turn/item", content: "A saved response", role: "assistant" as const };
  const onSubmit = vi.fn();
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.tagName === "ARTICLE" ? 180 : 20, 300, this.tagName === "ARTICLE" ? 40 : 200);
  });
  try {
    await act(async () => root.render(<WritingAgentPanel open draft="Unsent draft" searchTarget={target} historyReady={false} onSubmit={onSubmit} />));
    expect(host.textContent).toContain("正在加载命中消息");
    const textarea = host.querySelector("textarea")!;
    const transcript = host.querySelector<HTMLDivElement>(".writing-agent-messages")!;
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    transcript.scrollTop = 10; host.scrollTop = 33;
    await act(async () => root.render(<WritingAgentPanel open draft="Unsent draft" searchTarget={target} historyReady messages={[message]} onSubmit={onSubmit} />));
    const article = host.querySelector("article")!;
    expect(document.activeElement).toBe(article); expect(article.classList.contains("search-match")).toBe(true);
    expect(transcript.scrollTop).toBe(90); expect(host.scrollTop).toBe(33);
    textarea.focus();
    await act(async () => root.render(<WritingAgentPanel open draft="Unsent draft" searchTarget={target} historyReady messages={[{ ...message, content: "Continued response" }]} onSubmit={onSubmit} />));
    expect(document.activeElement).toBe(textarea); expect(host.querySelector("textarea")).toBe(textarea); expect(textarea.value).toBe("Unsent draft");
    await act(async () => root.render(<WritingAgentPanel open draft="Unsent draft" searchTarget={{ ...target, requestId: 2 }} historyReady messages={[message]} onSubmit={onSubmit} />));
    expect(document.activeElement).toBe(article); expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => root.render(<WritingAgentPanel open draft="Unsent draft" searchTarget={{ messageId: "missing", requestId: 3 }} historyReady messages={[message]} />));
    expect(host.textContent).toContain("未找到原搜索消息");
  } finally { geometry.mockRestore(); await act(async () => root.unmount()); host.remove(); }
});
it("reports history failure and never steals focus while the panel is hidden", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const target = { messageId: "turn/item", requestId: 1 };
  try {
    await act(async () => root.render(<WritingAgentPanel open searchTarget={target} historyReady={false} historyError />));
    expect(host.textContent).toContain("读取命中消息失败");
    await act(async () => root.render(<WritingAgentPanel open={false} searchTarget={target} historyReady messages={[{ id: target.messageId, content: "Saved", role: "user" }]} />));
    expect(document.activeElement?.tagName).not.toBe("ARTICLE");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("locates a complete source turn once, including terminal turns without messages", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const target = { turnId: "source", requestId: 1 };
  const messages = [{ id: "source/user", content: "Question", role: "user" as const }, { id: "source/answer", content: "Answer", role: "assistant" as const }];
  const render = (ready: boolean, failed = false) => root.render(<WritingAgentPanel open draft="Keep draft" searchTarget={target} historyReady={ready} historyError={failed} messages={messages} />);
  try {
    await act(async () => render(false)); const textarea = host.querySelector("textarea")!;
    expect(textarea.disabled).toBe(true); expect(document.activeElement).not.toBe(textarea); expect(host.textContent).toContain("正在加载来源轮次");
    await act(async () => render(false, true));
    expect(host.textContent).toContain("读取来源轮次失败"); expect(textarea.disabled).toBe(true); expect(document.activeElement).not.toBe(textarea);
    await act(async () => render(true));
    expect(document.activeElement).toBe(host.querySelector('[data-agent-message-id="source/answer"]'));
    expect(host.querySelector('[data-agent-message-id="source/answer"]')?.classList.contains("search-match")).toBe(true);
    textarea.focus(); await act(async () => render(true)); expect(document.activeElement).toBe(textarea); expect(textarea.value).toBe("Keep draft");
    await act(async () => root.render(<WritingAgentPanel open draft="Keep draft" searchTarget={{ turnId: "empty", requestId: 2 }} historyReady
      historyActions={<div data-agent-turn-id="empty" tabIndex={-1}>第 2 轮已结束</div>} />));
    expect(document.activeElement).toBe(host.querySelector('[data-agent-turn-id="empty"]'));
    await act(async () => root.render(<WritingAgentPanel open searchTarget={{ turnId: "missing", requestId: 3 }} historyReady />));
    expect(host.textContent).toContain("未找到分支来源轮次");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
