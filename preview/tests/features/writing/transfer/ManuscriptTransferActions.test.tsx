// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Manuscript } from "@research-assistant/writing";
import { downloadDir, join } from "@tauri-apps/api/path";
import { notify } from "@research-assistant/workbench-preview/feedback";
import type { WritingGateway } from "@research-assistant/writing-projects-preview/index";
import { ManuscriptTransferActions } from "@research-assistant/writing-projects-preview/manuscript-transfer-actions";

vi.mock("@tauri-apps/api/path", () => ({ downloadDir: vi.fn(), join: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@research-assistant/workbench-preview/notifications", () => ({ notify: { loading: vi.fn(), success: vi.fn(), error: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
beforeEach(() => {
  vi.mocked(downloadDir).mockResolvedValue("/Users/test/Downloads");
  vi.mocked(join).mockImplementation(async (...parts) => parts.join("/"));
  vi.mocked(notify.loading).mockReturnValue("download-task");
});
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.resetAllMocks(); });

async function mount(beforeExport = vi.fn(async () => true)) {
  const exportFile = vi.fn(async (_id: string, path: string) => ({ destinationPath: path, byteSize: 1024, fileCount: 1 }));
  const gateway = { supportsCompilation: true, exportPdf: exportFile, exportSource: exportFile } as unknown as WritingGateway;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ManuscriptTransferActions variant="exports" activeManuscript={{ id: "test", title: "Paper / draft" } as Manuscript} beforeExport={beforeExport} gateway={gateway} hasPdf onError={vi.fn()} onImported={vi.fn()} onResourcesImported={vi.fn()} />));
  return { exportFile, beforeExport, pdf: document.querySelectorAll<HTMLButtonElement>("button")[0]!, zip: document.querySelectorAll<HTMLButtonElement>("button")[1]! };
}

it.each(["pdf", "zip"] as const)("downloads %s to the OS Downloads folder with a visible result path", async (kind) => {
  const actions = await mount();
  await act(async () => actions[kind].click());
  expect(actions.beforeExport).toHaveBeenCalledOnce();
  expect(downloadDir).toHaveBeenCalledOnce();
  const destination = actions.exportFile.mock.calls[0]![1];
  expect(destination).toBe(`/Users/test/Downloads/Paper - draft.${kind}`);
  expect(notify.loading).toHaveBeenCalledOnce();
  expect(notify.success).toHaveBeenCalledWith(expect.stringContaining("Downloads"), expect.objectContaining({ id: "download-task", description: expect.stringContaining(destination) }));
  expect(notify.error).not.toHaveBeenCalled();
});

it("blocks repeated exports while the pre-export save is pending", async () => {
  let finish!: (value: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const actions = await mount(save);
  await act(async () => { actions.pdf.click(); actions.zip.click(); });
  expect(save).toHaveBeenCalledOnce();
  expect(actions.pdf.disabled).toBe(true);
  expect(actions.zip.disabled).toBe(true);
  expect(actions.exportFile).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(actions.exportFile).toHaveBeenCalledOnce();
  expect(actions.pdf.disabled).toBe(false);
});

it("reports a failed save without downloading", async () => {
  const actions = await mount(vi.fn(async () => false));
  await act(async () => actions.pdf.click());
  expect(downloadDir).not.toHaveBeenCalled();
  expect(actions.exportFile).not.toHaveBeenCalled();
  expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("请先保存"), { id: "download-task" });
});

it.each(["save", "directory", "write", "ipc"])("reports %s errors and allows retry", async (stage) => {
  const save = vi.fn(async () => true);
  const actions = await mount(save);
  const failure = new Error("Operation denied");
  if (stage === "save") save.mockRejectedValueOnce(failure);
  if (stage === "directory") vi.mocked(downloadDir).mockRejectedValueOnce(failure);
  if (stage === "write") actions.exportFile.mockRejectedValueOnce(failure);
  if (stage === "ipc") actions.exportFile.mockRejectedValueOnce({ code: "storage_error", message: "Operation denied" });
  await act(async () => actions.pdf.click());
  expect(notify.error).toHaveBeenCalledWith("PDF下载失败", { id: "download-task", description: "Operation denied" });
  expect(notify.success).not.toHaveBeenCalled();
  expect(actions.pdf.disabled).toBe(false);
  await act(async () => actions.pdf.click());
  expect(notify.success).toHaveBeenCalledOnce();
});
