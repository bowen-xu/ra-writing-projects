// @vitest-environment happy-dom
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({ notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { ManuscriptDeleteDialog } from "./ManuscriptDeleteDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("blocks duplicate deletion, preserves errors and permits explicit retry", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  let reject: (error: Error) => void = () => undefined;
  const onDelete = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const manuscript = { id: "id", title: "Paper", status: "archived" as const, rootPath: parseManuscriptPath("main.tex"), createdAt: "now", updatedAt: "now" };
  try {
    await act(async () => root.render(<ManuscriptDeleteDialog manuscript={manuscript} onDelete={onDelete} onClose={onClose} />));
    const button = host.querySelector<HTMLButtonElement>(".writing-delete-confirm")!;
    await act(async () => { button.click(); button.click(); });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    await act(async () => host.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error("磁盘不可写")));
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("磁盘不可写"));
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
