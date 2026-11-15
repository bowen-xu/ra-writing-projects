/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useWritingNavigation } from "./useWritingNavigation";

it("blocks local close and switch while protected and rejects navigation after an awaited save loses its owner", async () => {
  const root = createRoot(document.createElement("div"));
  let allowed = false, finish!: (value: boolean) => void;
  const saveCurrent = vi.fn().mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const openFile = vi.fn().mockResolvedValue({}), setActivePath = vi.fn(), setActiveManuscriptId = vi.fn(), setOpenPaths = vi.fn();
  let navigation!: ReturnType<typeof useWritingNavigation>;
  function Host({path}: {path: string}) {
    navigation = useWritingNavigation({activePath: path, activeManuscriptId: "m", openPaths: [path], saveState: "saved",
      canNavigate: () => allowed, saveCurrent, openFile, setActivePath, setActiveManuscriptId, setOpenPaths,
      setContent: vi.fn(), setContentHash: vi.fn(), setIsLibraryOpen: vi.fn(), setFocusRequest: vi.fn()});
    return null;
  }
  try {
    await act(async () => root.render(<Host path="main.tex"/>));
    await navigation.closeFile("main.tex"); await navigation.selectManuscript("other");
    expect(saveCurrent).not.toHaveBeenCalled(); expect(setOpenPaths).not.toHaveBeenCalled();
    allowed = true;
    const changing = navigation.selectFile("target.tex");
    await act(async () => root.render(<Host path="new-owner.tex"/>));
    finish(true); expect(await changing).toBe(false); expect(openFile).not.toHaveBeenCalled();
    saveCurrent.mockResolvedValue(true);
    await navigation.closeFile("new-owner.tex");
    expect(setActivePath).toHaveBeenCalledWith(undefined);
    expect(setOpenPaths).toHaveBeenCalledWith([]);
  } finally {await act(async () => root.unmount());}
});

it("does not complete an older preview selection after a later double-click selection", async () => {
  const root = createRoot(document.createElement("div"));
  const finishes: (() => void)[] = [], complete = vi.fn();
  const openFile = vi.fn().mockImplementation(() => new Promise(resolve => finishes.push(() => resolve({}))));
  let navigation!: ReturnType<typeof useWritingNavigation>;
  function Host() { navigation = useWritingNavigation({ activePath: "main.tex", activeManuscriptId: "m", openPaths: ["main.tex"], saveState: "saved",
    canNavigate: () => true, saveCurrent: async () => true, openFile,
    prepareTabOpen: (_, path, mode) => () => complete(path, mode), setActivePath: vi.fn(), setActiveManuscriptId: vi.fn(),
    setOpenPaths: vi.fn(), setContent: vi.fn(), setContentHash: vi.fn(), setIsLibraryOpen: vi.fn(), setFocusRequest: vi.fn() }); return null; }
  try {
    await act(async () => root.render(<Host />));
    const first = navigation.selectFile("next.tex", "preview"); await Promise.resolve();
    const second = navigation.selectFile("next.tex", "pinned"); await Promise.resolve();
    finishes[1]!(); expect(await second).toBe(true);
    finishes[0]!(); expect(await first).toBe(false);
    expect(complete).toHaveBeenCalledExactlyOnceWith("next.tex", "pinned");
  } finally { await act(async () => root.unmount()); }
});
