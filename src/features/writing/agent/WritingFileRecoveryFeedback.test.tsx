// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WritingToolbar } from "../WritingToolbar";
import { WritingFileRecoveryFeedback } from "./WritingFileRecoveryFeedback";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("places recovery as an accessible icon beside save status without a duplicate back button", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const retry = vi.fn();
  try {
    await act(async () => root.render(<WritingToolbar activeManuscript={undefined} saveState="saved" onSave={vi.fn()} onOpenCommands={vi.fn()} onSettings={vi.fn()} onRename={vi.fn()} projectActions={null} viewMode="split" onViewModeChange={vi.fn()} focused={false} onToggleFocus={vi.fn()} transferActions={null} recoveryActions={<WritingFileRecoveryFeedback delivery={<div className="writing-file-recovery-actions"><button onClick={retry}>重新读取</button></div>} undo={null} />} />));
    const toolbar = host.querySelector(".writing-toolbar")!;
    const recovery = toolbar.querySelector("details")!;
    expect(recovery.nextElementSibling?.classList.contains("save-state")).toBe(true);
    expect(toolbar.querySelector(".writing-back")).toBeNull();
    const summary = recovery.querySelector("summary")!;
    expect(summary.getAttribute("aria-label")).toBe("文件修改待处理");
    expect(summary.textContent).toBe("");
    await act(async () => summary.click()); expect(recovery.open).toBe(true);
    await act(async () => recovery.querySelector("button")!.click()); expect(retry).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
