/** @vitest-environment happy-dom */
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({ notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WritingInstructionSettings } from "./WritingInstructionSettings";
const mocks = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", () => ({ agentInstructionTrustGateway: mocks }));
const id = "11111111-1111-4111-8111-111111111111";
const initial = { schemaVersion: 1, manuscriptId: id, revision: 0, granted: false, rootMatches: false };
it("locks uncertain updates until reread and exposes stale-root recovery", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.read.mockResolvedValue(initial); mocks.update.mockRejectedValue(new Error("lost reply"));
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<WritingInstructionSettings manuscriptId={id} />));
    const toggle = container.querySelector("input")!;
    expect(toggle.checked).toBe(false);
    await act(async () => toggle.click());
    expect(mocks.update).toHaveBeenCalledWith(id, 0, true);
    expect(toggle.disabled).toBe(true);
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("设置结果尚未确认"));
    mocks.read.mockResolvedValue({ ...initial, revision: 1, granted: true });
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "重新读取状态")!.click());
    expect(toggle.checked).toBe(true); expect(toggle.disabled).toBe(false);
    expect(container.textContent).toContain("现有授权已失效");
    mocks.update.mockResolvedValue({ ...initial, revision: 2 });
    await act(async () => toggle.click());
    expect(mocks.update).toHaveBeenLastCalledWith(id, 1, false);
    expect(notify.info).toHaveBeenCalledWith("已停止加载新的项目指令。");
  } finally { await act(async () => root.unmount()); }
});
it("ignores a previous manuscript's late read", async () => {
  let resolve!: (value: unknown) => void;
  mocks.read.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ...initial, manuscriptId: "new" });
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<WritingInstructionSettings manuscriptId={id} />));
    await act(async () => root.render(<WritingInstructionSettings manuscriptId="new" />));
    await act(async () => resolve({ ...initial, revision: 1, granted: true, rootMatches: true }));
    expect(container.querySelector("input")!.checked).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
