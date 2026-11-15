/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WritingSteeringRecovery } from "./WritingSteeringRecovery";
const mocks = vi.hoisted(() => ({ readWritingRecovery: vi.fn() }));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", () => ({ agentSteeringRecoveryGateway: mocks }));

async function harness() {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const restored = vi.fn();
  const render = async (disabled = false) => { await act(async () => root.render(<WritingSteeringRecovery
    conversationId="conversation" manuscriptId="manuscript" turns={[{ id: "old", label: "第 1 轮" }, { id: "latest", label: "第 2 轮" }]}
    disabled={disabled} onRestore={restored} />)); };
  await render();
  const click = async (text: string) => { await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === text)!.click()); };
  return { container, restored, render, click, close: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const answer = (text: string) => ({ inputs: [{ inputId: text, text }] });

it("loads on demand and restores each input once without sending", async () => {
  const h = await harness();
  mocks.readWritingRecovery.mockResolvedValue(answer("保留原文\n"));
  try {
    expect(mocks.readWritingRecovery).not.toHaveBeenCalled();
    await h.click("找回未处理的补充说明");
    expect(mocks.readWritingRecovery).toHaveBeenCalledWith({ conversationId: "conversation", manuscriptId: "manuscript", turnId: "latest" });
    await h.click("恢复到草稿");
    await h.click("已恢复到草稿");
    expect(h.restored).toHaveBeenCalledExactlyOnceWith("保留原文\n");
  } finally { await h.close(); }
});

it("ignores late responses after choosing another terminal turn", async () => {
  const h = await harness(); let resolve!: (value: unknown) => void;
  mocks.readWritingRecovery.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue(answer("older"));
  try {
    await h.click("找回未处理的补充说明");
    await act(async () => { const select = h.container.querySelector("select")!; select.value = "old"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => resolve(answer("stale")));
    expect(h.container.textContent).toContain("older");
    expect(h.container.textContent).not.toContain("stale");
  } finally { await h.close(); }
});

it("keeps failures retryable and blocks recovery during another submission", async () => {
  const h = await harness();
  mocks.readWritingRecovery.mockRejectedValueOnce({ code: "closed" }).mockResolvedValue(answer("recoverable"));
  try {
    await h.click("找回未处理的补充说明");
    expect(h.container.querySelector('[role="alert"]')).not.toBeNull();
    await h.click("重试读取");
    await h.render(true);
    expect(h.container.textContent).toContain("请先结束当前运行");
    expect([...h.container.querySelectorAll("button")].some((button) => button.textContent === "恢复到草稿")).toBe(false);
    expect(h.restored).not.toHaveBeenCalled();
  } finally { await h.close(); }
});
