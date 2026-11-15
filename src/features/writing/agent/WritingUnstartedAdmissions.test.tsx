/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WritingUnstartedAdmissions } from "./WritingUnstartedAdmissions";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", () => ({ agentQueueAdmissionsGateway: mocks }));
it("loads on demand, opens original records and pages without executing them", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.list.mockReset();
  const item = { inputId: "input", expectedRevision: 4, preview: { input: { text: "Saved message" } } };
  mocks.list.mockResolvedValue({ items: [item], nextCursor: "input" });
  const onReview = vi.fn(); const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingUnstartedAdmissions conversationId="conversation" manuscriptId="manuscript" disabled={false} onReview={onReview} />));
    expect(mocks.list).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")!.click());
    expect(mocks.list).toHaveBeenCalledWith({ conversationId: "conversation", manuscriptId: "manuscript", after: null, limit: 20 });
    expect(onReview).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "查看原提交")!.click());
    expect(onReview).toHaveBeenCalledWith(item);
    mocks.list.mockRejectedValueOnce(new Error("offline"));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "下一页")!.click());
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ after: "input" }));
    expect(container.textContent).toContain("读取失败"); expect(container.textContent).not.toContain("本页没有");
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "刷新本页")!.click());
    expect(container.textContent).toContain("本页没有未启动的提交");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("drops a late page when the bound manuscript changes", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.list.mockReset();
  let resolve!: (page: unknown) => void;
  mocks.list.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue({ items: [], nextCursor: null });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingUnstartedAdmissions conversationId="conversation" manuscriptId="first" disabled={false} onReview={vi.fn()} />));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => root.render(<WritingUnstartedAdmissions conversationId="conversation" manuscriptId="second" disabled={false} onReview={vi.fn()} />));
    await act(async () => resolve({ items: [{ inputId: "stale", expectedRevision: 1, preview: { input: { text: "stale" } } }], nextCursor: null }));
    expect(container.textContent).not.toContain("stale");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
