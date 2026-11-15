import { expect, it } from "vitest";
import { WritingProjectTabs } from "./WritingProjectTabs";

function state(manuscriptId: string, openPaths: readonly string[] = []) {
  return { manuscriptId, openPaths, activePath: openPaths.at(-1), cursorState: {}, layoutState: {} };
}
it("replaces only the current project's preview and preserves fixed tabs and project positions", () => {
  const tabs = new WritingProjectTabs();
  tabs.sync({ ...state("a", ["main.tex"]), cursorState: { "main.tex": 17 }, layoutState: { mode: "editor" } });
  tabs.prepareOpen("a", "one.tex", "preview")();
  tabs.sync(state("b", ["main.tex"]));
  tabs.prepareOpen("b", "note.tex", "preview")();
  expect(tabs.prepareOpen("a", "two.tex", "preview")()).toEqual(["main.tex", "two.tex"]);
  expect(tabs.get("a")).toMatchObject({ previewPath: "two.tex", cursorState: { "main.tex": 17 }, layoutState: { mode: "editor" } });
  expect(tabs.get("b")).toMatchObject({ openPaths: ["main.tex", "note.tex"], previewPath: "note.tex" });
  tabs.pin("a", "two.tex");
  expect(tabs.prepareOpen("a", "third.tex", "preview")()).toEqual(["main.tex", "two.tex", "third.tex"]);
  tabs.prepareOpen("a", "main.tex", "preview")();
  expect(tabs.get("a")?.previewPath).toBe("third.tex");
});
it("keeps a double-click pin received while the first file read is pending", () => {
  const tabs = new WritingProjectTabs(); tabs.sync(state("a"));
  const firstClick = tabs.prepareOpen("a", "file.tex", "preview");
  const doubleClick = tabs.prepareOpen("a", "file.tex", "pinned");
  doubleClick(); firstClick();
  expect(tabs.get("a")).toMatchObject({ openPaths: ["file.tex"], previewPath: undefined });
});
it("captures preview disposition before loader metadata adds the path", () => {
  const tabs = new WritingProjectTabs(); tabs.sync(state("a", ["main.tex"]));
  const finish = tabs.prepareOpen("a", "new.tex", "preview");
  tabs.sync(state("a", ["main.tex", "new.tex"]));
  finish(); expect(tabs.get("a")?.previewPath).toBe("new.tex");
});
it("closes remote project tabs without changing another project and allows a closed fixed path to reopen as preview", () => {
  const tabs = new WritingProjectTabs(); tabs.sync(state("a")); tabs.sync(state("b", ["main.tex"]));
  tabs.prepareOpen("a", "main.tex", "pinned")(); tabs.close("a", "main.tex");
  expect(tabs.get("a")).toMatchObject({ openPaths: [], activePath: undefined });
  expect(tabs.get("b")?.activePath).toBe("main.tex");
  tabs.prepareOpen("a", "main.tex", "preview")();
  expect(tabs.get("a")?.previewPath).toBe("main.tex");
  tabs.pin("a", "main.tex"); tabs.sync(state("a")); tabs.prepareOpen("a", "main.tex", "preview")();
  expect(tabs.get("a")?.previewPath).toBe("main.tex");
  tabs.retainProjects(["b"]); expect(tabs.getSnapshot().map(project => project.manuscriptId)).toEqual(["b"]);
});
