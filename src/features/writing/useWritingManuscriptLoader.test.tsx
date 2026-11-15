// @vitest-environment happy-dom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath, type Manuscript } from "@research-assistant/writing";
import { useWritingManuscriptLoader } from "./useWritingManuscriptLoader";
import { WritingProjectTabs } from "./tabs/WritingProjectTabs";

const manuscript: Manuscript = {
  id: "m", title: "Existing manuscript", rootPath: parseManuscriptPath("main.tex"),
  status: "active", createdAt: "now", updatedAt: "now",
};

function harness(initialId?: string, tabs?: WritingProjectTabs) {
  const root = createRoot(document.createElement("div"));
  const gateway = {
    listManuscripts: vi.fn().mockResolvedValue([manuscript]),
    listFiles: vi.fn().mockResolvedValue([]), listDirectories: vi.fn().mockResolvedValue([]),
    listCitationBindings: vi.fn().mockResolvedValue([]), getBibliographyStatus: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(undefined), listRecoveryDrafts: vi.fn().mockResolvedValue([]),
    supportsCompilation: false,
  };
  const openFile = vi.fn().mockResolvedValue({ content: "source", sha256: "hash" });
  type Options = Parameters<typeof useWritingManuscriptLoader>[0];
  const dependencies = {
    gateway: gateway as unknown as Options["gateway"],
    checkpoints: { hasCheckpoint: vi.fn().mockReturnValue(false) } as unknown as Options["checkpoints"],
    openFile, layout: { restore: vi.fn() },
    setFiles: vi.fn(), setDirectories: vi.fn(), setOpenPaths: vi.fn(), setActivePath: vi.fn(),
    setContent: vi.fn(), setContentHash: vi.fn(), setSaveState: vi.fn(), setIsLoading: vi.fn(),
    setError: vi.fn(), setCitationBindings: vi.fn(), setBibliographyStatus: vi.fn(), setCursorOffsets: vi.fn(),
    setAutoCompile: vi.fn(), setCompilePreferences: vi.fn(), setPendingRecovery: vi.fn(),
  } satisfies Omit<Options, "activeManuscript" | "activeManuscriptId" | "loadedManuscriptId" | "setLoadedManuscriptId" | "setManuscripts" | "setActiveManuscriptId">;
  let selected: string | undefined;
  let select!: Dispatch<SetStateAction<string | undefined>>;
  function Host() {
    const [manuscripts, setManuscripts] = useState<readonly Manuscript[]>([]);
    const [id, setId] = useState(initialId);
    const [, setLoadedManuscriptId] = useState<string>();
    selected = id; select = setId;
    useWritingManuscriptLoader({ ...dependencies, ...(tabs ? { tabs } : {}), setLoadedManuscriptId,
      activeManuscript: manuscripts.find(item => item.id === id), setManuscripts, setActiveManuscriptId: setId });
    return null;
  }
  return { gateway, openFile, dependencies, selected: () => selected,
    render: () => act(async () => root.render(<Host />)),
    select: (id: string) => act(async () => select(id)),
    dispose: () => act(async () => root.unmount()),
  };
}

it("loads only manuscript summaries until the user explicitly opens a manuscript", async () => {
  const h = harness();
  try {
    await h.render();
    expect(h.gateway.listManuscripts).toHaveBeenCalledOnce();
    expect(h.selected()).toBeUndefined();
    for (const method of [h.gateway.listFiles, h.gateway.listDirectories, h.gateway.listCitationBindings,
      h.gateway.getBibliographyStatus, h.gateway.getSession, h.gateway.listRecoveryDrafts, h.openFile]) {
      expect(method).not.toHaveBeenCalled();
    }
    await h.select(manuscript.id);
    expect(h.gateway.listFiles).toHaveBeenCalledExactlyOnceWith(manuscript.id);
    expect(h.openFile).toHaveBeenCalledExactlyOnceWith(manuscript.rootPath, manuscript.id, expect.any(Function), {files: [], openPaths: []});
    await h.render();
    expect(h.openFile).toHaveBeenCalledOnce();
    expect(h.dependencies.setError).not.toHaveBeenCalled();
  } finally { await h.dispose(); }
});

it("honors an explicitly requested manuscript when the summary list arrives", async () => {
  const h = harness(manuscript.id);
  try {
    await h.render();
    expect(h.selected()).toBe(manuscript.id);
    expect(h.openFile).toHaveBeenCalledExactlyOnceWith(manuscript.rootPath, manuscript.id, expect.any(Function), {files: [], openPaths: []});
  } finally { await h.dispose(); }
});

it("restores the live project's tabs and positions instead of stale persisted session metadata", async () => {
  const tabs = new WritingProjectTabs(); tabs.sync({ manuscriptId: "m", openPaths: ["main.tex", "second.tex"], activePath: "second.tex",
    cursorState: { "second.tex": 42 }, layoutState: { viewMode: "editor" } });
  const h = harness("m", tabs);
  h.gateway.listFiles.mockResolvedValue(["main.tex", "second.tex"].map(relativePath => ({ manuscriptId: "m", relativePath })) as never);
  h.gateway.getSession.mockResolvedValue({ openPaths: ["main.tex"], activePath: "main.tex", cursorState: {}, layoutState: {} } as never);
  try {
    await h.render();
    expect(h.dependencies.setOpenPaths).toHaveBeenLastCalledWith(["main.tex", "second.tex"]);
    expect(h.dependencies.setCursorOffsets).toHaveBeenLastCalledWith({ "second.tex": 42 });
    expect(h.dependencies.layout.restore).toHaveBeenLastCalledWith({ viewMode: "editor" });
    expect(h.openFile).toHaveBeenCalledExactlyOnceWith("second.tex", "m", expect.any(Function), {files: await h.gateway.listFiles.mock.results[0]!.value, openPaths: ["main.tex", "second.tex"]});
  } finally { await h.dispose(); }
});
it("does not reopen a project's last closed tab from an older disk session", async () => {
  const tabs = new WritingProjectTabs(); tabs.sync({ manuscriptId: "m", openPaths: [], activePath: undefined, cursorState: {}, layoutState: {} });
  const h = harness("m", tabs);
  h.gateway.listFiles.mockResolvedValue([{ manuscriptId: "m", relativePath: "main.tex" }] as never);
  h.gateway.getSession.mockResolvedValue({ openPaths: ["main.tex"], activePath: "main.tex" } as never);
  try { await h.render(); expect(h.openFile).not.toHaveBeenCalled(); expect(h.dependencies.setOpenPaths).toHaveBeenLastCalledWith([]); }
  finally { await h.dispose(); }
});
