// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseManuscriptPath, type Manuscript } from "@research-assistant/writing";
import { WorkspaceTabBar, WorkspaceTabsProvider } from "@research-assistant/workbench-preview/workbench-c5927e";
import { WritingFileSessions } from "@research-assistant/writing-projects-preview/writing-file-sessions";
import { WritingProjectTabs } from "@research-assistant/writing-projects-preview/writing-project-tabs";
import { useWritingWorkspaceTabs } from "@research-assistant/writing-projects-preview/use-writing-workspace-tabs";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
type Options = Parameters<typeof useWritingWorkspaceTabs>[0];
const manuscripts = ["a", "b"].map(id => ({ id, title: `Project ${id}`, rootPath: parseManuscriptPath("main.tex"),
  createdAt: "now", updatedAt: "now", status: "active" } satisfies Manuscript));
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); });
async function harness(overrides: Partial<Options> = {}) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const store = new WritingProjectTabs(), files = new WritingFileSessions();
  for (const manuscriptId of ["a", "b"]) store.sync({ manuscriptId, openPaths: ["main.tex"], activePath: "main.tex", cursorState: {}, layoutState: {} });
  const options: Options = { store, files, manuscripts, manuscriptId: "b", activePath: "main.tex", openPaths: ["main.tex"],
    cursorState: {}, layoutState: {}, ready: true, active: true, home: false, saveState: "saved", canNavigate: () => true,
    saves: { save: vi.fn().mockResolvedValue({}) } as unknown as Options["saves"], selectProject: vi.fn().mockResolvedValue(true),
    selectFile: vi.fn().mockResolvedValue(true), closeFile: vi.fn().mockResolvedValue(undefined), setOpenPaths: vi.fn(),
    onHome: vi.fn(), showEditor: vi.fn(), ...overrides };
  let api!: ReturnType<typeof useWritingWorkspaceTabs>;
  function Publisher({ value }: { value: Options }) { api = useWritingWorkspaceTabs(value); return null; }
  function Shell({ value }: { value: Options }) { return <WorkspaceTabsProvider><Publisher value={value} />
    <WorkspaceTabBar owner="writing" textActive={false} navigate={(_, __, ready) => { ready(); return true; }} /></WorkspaceTabsProvider>; }
  const render = async (patch: Partial<Options> = {}) => { Object.assign(options, patch); await act(async () => root.render(<Shell value={{ ...options }} />)); };
  dispose = async () => { await act(async () => root.unmount()); host.remove(); };
  await render();
  const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  return { host, options, store, files, render, click, api: () => api };
}
it("retains both projects and waits for the selected project's loader before opening its file", async () => {
  const h = await harness();
  expect(h.host.querySelectorAll('[role="tab"]')).toHaveLength(3);
  await h.click('[data-tab-id="writing:a:main.tex"] [role="tab"]');
  expect(h.options.selectProject).toHaveBeenCalledWith("a"); expect(h.options.selectFile).not.toHaveBeenCalled();
  await h.render({ manuscriptId: "a", ready: false });
  expect(h.options.selectFile).not.toHaveBeenCalled();
  await h.render({ ready: true });
  expect(h.options.selectFile).toHaveBeenCalledExactlyOnceWith("main.tex", "preview");
  expect(h.options.showEditor).toHaveBeenCalledOnce();
  expect(h.host.querySelector('[data-tab-id="writing:b:main.tex"]')).not.toBeNull();
});
it("leaves tabs intact when the save boundary rejects switching projects", async () => {
  const h = await harness({ selectProject: vi.fn().mockResolvedValue(false) });
  await h.click('[data-tab-id="writing:a:main.tex"] [role="tab"]');
  await h.render(); expect(h.options.selectFile).not.toHaveBeenCalled();
  expect(h.options.showEditor).not.toHaveBeenCalled(); expect(h.store.get("a")?.openPaths).toEqual(["main.tex"]);
});
it("cancels a pending cross-project file activation when the user leaves that project", async () => {
  const h = await harness();
  await h.click('[data-tab-id="writing:a:main.tex"] [role="tab"]');
  await h.render({ manuscriptId: "a", ready: false });
  await h.render({ manuscriptId: "b", ready: true });
  await h.render({ manuscriptId: "a", ready: true });
  expect(h.options.selectFile).not.toHaveBeenCalled(); expect(h.options.showEditor).not.toHaveBeenCalled();
});
it("saves the exact remote file identity before closing without switching projects, and retains it on failure", async () => {
  const h = await harness(); h.files.open({ manuscriptId: "a", relativePath: "main.tex" }, "source", "hash");
  const save = vi.mocked(h.options.saves.save); save.mockRejectedValueOnce(new Error("conflict"));
  await h.click('[aria-label="关闭 main.tex · Project a"]');
  expect(h.store.get("a")?.openPaths).toEqual(["main.tex"]);
  await h.click('[aria-label="关闭 main.tex · Project a"]');
  expect(save).toHaveBeenLastCalledWith({ manuscriptId: "a", relativePath: "main.tex" });
  expect(h.store.get("a")?.openPaths).toEqual([]); expect(h.options.selectProject).not.toHaveBeenCalled();
  expect(h.host.querySelector('[data-tab-id="writing:b:main.tex"]')).not.toBeNull();
});
it("pins edited or pending previews and isolates a double-click pin from another project's same path", async () => {
  const h = await harness();
  await act(async () => { h.api().prepareOpen("b", "next.tex", "preview")(); });
  await h.render({ openPaths: ["main.tex", "next.tex"], activePath: "next.tex", saveState: "dirty" });
  expect(h.store.get("b")?.previewPath).toBeUndefined();
  await act(async () => { h.store.prepareOpen("a", "main.tex", "preview")(); h.store.prepareOpen("a", "other.tex", "preview")(); });
  const session = h.files.open({ manuscriptId: "a", relativePath: "other.tex" }, "before", "hash");
  await act(async () => { session.applyAgent("test", 0, "after"); });
  expect(h.store.get("a")?.previewPath).toBeUndefined();
  expect(h.store.get("b")?.openPaths).toEqual(["main.tex", "next.tex"]);
});
