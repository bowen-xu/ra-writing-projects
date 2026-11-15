import {expect, it, vi} from "vitest";
import {parseManuscriptPath, inspectCitationKeys, inspectCitationUsage, type ManuscriptFile} from "@research-assistant/writing";
import {WritingSourceReads} from "./WritingSourceReads";
import {WritingBibliographyReads} from "./WritingBibliographyReads";
const file = (sha256 = "one"): ManuscriptFile => ({manuscriptId: "m", relativePath: parseManuscriptPath("chapter.tex"), kind: "tex", sha256, sizeBytes: 10, modifiedAt: "now"});
it("coalesces committed reads and parsing by project, path and hash while keeping live buffers independent", async () => {
  const readFile = vi.fn(async () => ({sha256: "one", content: "\\section{Saved}\\label{saved}\\cite{a}"}));
  const cache = new WritingSourceReads({readFile} as never);
  const values = await Promise.all(Array.from({length: 20}, () => cache.committed("m", file())));
  expect(readFile).toHaveBeenCalledOnce(); expect(values.every(value => value === values[0])).toBe(true);
  const live = cache.live("m", "chapter.tex", "\\section{Unsaved}\\cite{b}");
  expect(cache.live("m", "chapter.tex", live.source)).toBe(live);
  expect(live.index.outline[0]?.title).toBe("Unsaved"); expect(values[0]?.index.outline[0]?.title).toBe("Saved");
  readFile.mockResolvedValue({sha256: "two", content: "\\section{Updated}"});
  expect((await cache.committed("m", file("two"))).index.outline[0]?.title).toBe("Updated");
  await cache.committed("other-project", file("two")); expect(readFile).toHaveBeenCalledTimes(3);
});
it("does not retain failed or concurrently changed reads and drops deleted project paths", async () => {
  const readFile = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({sha256: "changed", content: "new"});
  const cache = new WritingSourceReads({readFile} as never);
  await expect(cache.committed("m", file())).rejects.toThrow("offline");
  await cache.committed("m", file()); await cache.committed("m", file());
  expect(readFile).toHaveBeenCalledTimes(3);
  await cache.committed("m", file("changed")); cache.prune("m", []); await cache.committed("m", file("changed"));
  expect(readFile).toHaveBeenCalledTimes(5);
});
it("retains wildcard semantics when bibliography bindings change without reparsing source", () => {
  const source = "% \\cite{ignored}\n\\citep*[p. 3]{a,missing}\\nocite{*}";
  const cache = new WritingSourceReads({} as never), parsed = cache.live("m", "main.tex", source);
  for (const managed of [["a"], ["a", "b"]]) expect(inspectCitationKeys(parsed.citationKeys, [], managed)).toEqual(inspectCitationUsage([source], [], managed));
});
it("does not reconcile bibliography on file switches or reactivation, but handles committed saves and retry", async () => {
  const syncBibliography = vi.fn(async () => ({status: "ready" as const, relativePath: parseManuscriptPath("references.bib"), warnings: []}));
  const cache = new WritingBibliographyReads({syncBibliography, listFiles: async () => [],supportsCompilation:false},{get:vi.fn()});
  async function deliver(read: ReturnType<WritingBibliographyReads["ensure"]>) {
    if (!read) throw Error("Expected a pending bibliography projection");
    const release = read.observe();
    try {expect((await read.value).kind).toBe("ready");read.accept();} finally {release();}
  }
  const first = cache.ensure("m", [["a.tex", "a-one"], ["b.tex", "b-one"]], "a.tex", "a-one");
  expect(cache.ensure("m", [["a.tex", "a-one"], ["b.tex", "b-one"]], "b.tex", "b-one")).toBe(first); await deliver(first);
  for(let visit = 0; visit < 20; visit++) expect(cache.ensure("m", [["a.tex", "a-one"], ["b.tex", "b-one"]], visit % 2 ? "a.tex" : "b.tex", visit % 2 ? "a-one" : "b-one")).toBeUndefined();
  expect(syncBibliography).toHaveBeenCalledOnce();
  const saved = cache.ensure("m", [["a.tex", "a-one"], ["b.tex", "b-one"]], "a.tex", "a-two");
  await deliver(saved); expect(syncBibliography).toHaveBeenCalledTimes(2);
  expect(cache.ensure("m", [["a.tex", "a-two"], ["b.tex", "b-one"]], "a.tex", "a-two")).toBeUndefined();
  syncBibliography.mockRejectedValueOnce(new Error("conflict"));
  await expect(deliver(cache.ensure("m", [["a.tex", "a-three"], ["b.tex", "b-one"]], "a.tex", "a-three"))).rejects.toThrow("conflict");
  await deliver(cache.ensure("m", [["a.tex", "a-three"], ["b.tex", "b-one"]], "a.tex", "a-three")); expect(syncBibliography).toHaveBeenCalledTimes(4);
});
