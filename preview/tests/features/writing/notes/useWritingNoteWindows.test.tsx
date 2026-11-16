// @vitest-environment happy-dom
import { act, useImperativeHandle, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useWritingNoteWindows } from "@research-assistant/writing-projects-preview/use-writing-note-windows";
import { createBrowserWritingGateway } from "@research-assistant/writing-projects-preview/browser-writing-gateway";
import { useNoteDocumentTabHost } from "@research-assistant/workbench-preview/use-note-document-tab-host";
import { navigateSource } from "@research-assistant/workbench-preview/source-navigation";
const state = vi.hoisted(() => ({ prepare: vi.fn(async () => true) }));
vi.mock("@research-assistant/workbench-preview/source-navigation", () => ({ navigateSource: vi.fn(async () => undefined) }));
vi.mock("@research-assistant/writing-projects-preview/writing-note-floating-panel", () => ({ WritingNoteFloatingPanel: (props: ComponentProps<typeof import("@research-assistant/writing-projects-preview/writing-note-floating-panel").WritingNoteFloatingPanel>) => {
  useImperativeHandle(props.windowRef, () => ({ prepareClose: state.prepare }));
  return <section aria-label="浮窗"><button type="button" onClick={() => void props.onExpand(props.target)}>展开</button><span>{props.target.path}</span></section>;
} }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("opens notes without selecting them in the source pane and transfers expansion through shared source navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host), select = vi.fn(async () => true), close = vi.fn(async () => {});
  let windows!: ReturnType<typeof useWritingNoteWindows>;
  function Shell() { useNoteDocumentTabHost({chooseView: vi.fn(() => true), openPage: vi.fn()}); windows = useWritingNoteWindows({ gateway: createBrowserWritingGateway(), manuscriptId: "project", activePath: "main.tex", rootPath: "main.tex", openPaths: ["main.tex"], selectFile: select, closeFile: close, setFiles: vi.fn() }); return windows.surface; }
  try {
    await act(async () => root.render(<Shell />));
    await act(async () => { expect(await windows.open("notes/思路.ranote")).toBe(true); });
    expect(select).not.toHaveBeenCalled(); expect(host.textContent).toContain("notes/思路.ranote");
    await act(async () => host.querySelector('button')!.click());
    expect(navigateSource).toHaveBeenCalledWith("source://writings/project/notes/%E6%80%9D%E8%B7%AF.ranote", {presentation: "document"});
    state.prepare.mockResolvedValueOnce(false);
    await act(async () => { expect(await windows.pin("notes/思路.ranote")).toBe(false); });
    expect(select).not.toHaveBeenCalled(); expect(host.querySelector('[aria-label="浮窗"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});
