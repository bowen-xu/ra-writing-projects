// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {emptyLiteratureDraft} from "@research-assistant/core/literature";
import type {ProjectBibliographyEntry} from "@research-assistant/writing";
import type {WritingGateway} from "../gateway";
import {BibliographyManager} from "./BibliographyManager";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const stop of cleanup.splice(0).reverse()) await stop(); vi.unstubAllGlobals();});
function entry(id: string, extra: Partial<ProjectBibliographyEntry> = {}): ProjectBibliographyEntry {
  const draft = {...emptyLiteratureDraft(), title: `Saved ${id}`, bibtexKey: id};
  return {id, manuscriptId: "project", citationKey: id, originalKey: id, originalBibtex: `@article{${id},title={Saved}}`,
    bibtexEntry: `@article{${id},title={Saved}}`, imported: draft, current: draft, libraryItem: null, paths: ["references.bib"], ...extra};
}
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = [entry("linked", {libraryItemId: "stored-source"}), entry("binding:legacy-source"), entry("local")];
  const update = vi.fn(async () => undefined), insert = vi.fn();
  const gateway = {listBibliographyEntries: vi.fn(async () => rows), updateBibliographyEntry: update} as unknown as WritingGateway;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  cleanup.push(async () => {await act(async () => root.unmount()); host.remove();});
  await act(async () => root.render(<BibliographyManager manuscriptId="project" gateway={gateway} literature={undefined}
    onClose={() => undefined} onChanged={async () => undefined} onBeforeCleanup={async () => undefined} onInsert={insert}/>));
  return {host, rows, update, insert};
}
it("keeps a persisted relation without a snapshot and an old wire binding read-only when their provider is absent", async () => {
  const {host, update, insert} = await setup();
  expect(host.textContent).toContain("literature_citations_unavailable");
  for (const key of ["linked", "binding:legacy-source"]) {
    const article = [...host.querySelectorAll("article")].find(node => node.querySelector("code")?.textContent === key)!;
    expect(article.textContent).toContain("关联文献（暂不可用）");
    await act(async () => [...article.querySelectorAll("button")].find(button => button.textContent === "插入引用")!.click());
    expect(insert).toHaveBeenLastCalledWith(key);
    await act(async () => [...article.querySelectorAll("button")].find(button => button.textContent === "查看已保存版本")!.click());
    expect(host.querySelector(".bibliography-manager-tools span")?.textContent).toBe("关联文献库");
    expect(host.querySelector("thead th:last-child")?.textContent).toBe("已保存版本（只读）");
    expect(host.querySelector<HTMLInputElement>('[aria-label="编辑标题"]')?.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>("footer button")].find(button => button.textContent === "保存条目")?.disabled).toBe(true);
    expect(host.textContent).toContain("只读保留原引用键与关联");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "返回条目")!.click());
  }
  expect(update).not.toHaveBeenCalled();
});
it("continues editing a genuine local entry without requiring the optional library", async () => {
  const {host, rows, update} = await setup();
  const article = [...host.querySelectorAll("article")].find(node => node.querySelector("code")?.textContent === "local")!;
  await act(async () => [...article.querySelectorAll("button")].find(button => button.textContent === "编辑")!.click());
  expect(host.querySelector(".bibliography-manager-tools span")?.textContent).toBe("仅此稿件");
  expect(host.querySelector("thead th:last-child")?.textContent).toBe("稿件 · 拟保存");
  const title = host.querySelector<HTMLInputElement>('[aria-label="编辑标题"]')!;
  expect(title.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Edited local title");
    title.dispatchEvent(new Event("input", {bubbles: true}));
  });
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("footer button")].find(button => button.textContent === "保存条目")!.click());
  expect(update).toHaveBeenCalledExactlyOnceWith("project", "local", rows[2]!.bibtexEntry, expect.objectContaining({title: "Edited local title"}));
});
