// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {parseManuscriptPath, type ManuscriptFile} from "@research-assistant/writing";
import type {WritingGateway} from "./gateway";
import {useWritingSourceIndex} from "./useWritingSourceIndex";

it("pauses hidden source analysis and reuses other files when typing or returning", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const readFile = vi.fn(async () => ({sha256: "one", content: "\\label{other}"}));
  const gateway = {readFile, syncBibliography: vi.fn(async () => ({})), listFiles: vi.fn(async () => files), listBibliographyEntries: vi.fn(async () => [])} as unknown as WritingGateway;
  const files: readonly ManuscriptFile[] = ["main.tex", "other.tex"].map(path => ({manuscriptId: "m", relativePath: parseManuscriptPath(path), kind: "tex", sha256: "one", sizeBytes: 10, modifiedAt: "now"}));
  const setError = vi.fn();
  const literatureGateway = {get:vi.fn()};
  function Host({enabled, content}: {enabled: boolean; content: string}) {
    useWritingSourceIndex({enabled, gateway, literatureGateway, files, setError, activeManuscriptId: "m", activePath: "main.tex", content, savedContentHash: "one", citationBindings: []}); return null;
  }
  try {
    await act(async () => root.render(<Host enabled={false} content="hidden"/>));
    await act(async () => vi.advanceTimersByTime(1000)); expect(readFile).not.toHaveBeenCalled(); expect(gateway.syncBibliography).not.toHaveBeenCalled();
    await act(async () => root.render(<Host enabled content="first"/>));
    await act(async () => vi.advanceTimersByTime(250)); expect(readFile).toHaveBeenCalledOnce();
    for(let change = 0; change < 5; change++) {
      await act(async () => root.render(<Host enabled content={`edit ${change}`}/>));
      await act(async () => vi.advanceTimersByTime(250));
    }
    await act(async () => root.render(<Host enabled={false} content="edit 4"/>));
    await act(async () => root.render(<Host enabled content="edit 4"/>));
    await act(async () => vi.advanceTimersByTime(250));
    expect(readFile).toHaveBeenCalledOnce(); expect(gateway.syncBibliography).toHaveBeenCalledOnce(); expect(setError).not.toHaveBeenCalled();
  } finally {await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals();}
});
