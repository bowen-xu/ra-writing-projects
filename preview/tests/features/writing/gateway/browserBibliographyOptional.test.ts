// @vitest-environment happy-dom
import {expect, it, vi} from "vitest";
import {parseManuscriptPath, type ManuscriptFileContent} from "@research-assistant/writing";
import type {LiteratureItem} from "@research-assistant/core/literature";
import {createBrowserBibliography} from "@research-assistant/writing-projects-preview/browser-bibliography";

const availability = vi.hoisted(() => ({available: true, get: vi.fn(), list: vi.fn()}));
vi.mock("@research-assistant/workbench-preview/domain-capabilities", () => ({getOptionalLiteratureGateway: () => availability.available
  ? {get: availability.get, list: availability.list} : undefined}));

it("preserves stored bindings and manuscript bibliography while the library is absent, then restores interoperability", async () => {
  const item: LiteratureItem = {id: "library", itemType: "journalArticle", title: "Synthetic", abstractText: "", issuedYear: 2026,
    containerTitle: "Journal", volume: "", issue: "", pages: "", doi: "", url: "", language: "", bibtexKey: "stable2026",
    creators: [{familyName: "Example", givenName: "Alice", literalName: "", role: "author"}], tags: [], readingStatus: "unread",
    attachments: [], projectIds: [], metadataSources: [], createdAt: "now", updatedAt: "now"};
  availability.available = true; availability.get.mockResolvedValue(item); availability.list.mockResolvedValue([item]);
  localStorage.clear();
  localStorage.setItem("unrelated-conversation-draft", "unsent input");
  const records = new Map<string, ManuscriptFileContent>();
  const put = (file: string, content: string) => records.set(file, {relativePath: parseManuscriptPath(file), content, sha256: content});
  put("main.tex", "\\cite{stable2026}"); put("local.bib", "@book{local2025,title={Local imported record},year={2025}}");
  const files = {list: () => [...records.values()], stat: (_id: string, file: string) => records.get(file),
    write: async (_id: string, file: string, content: string) => {put(file, content);}};
  const initial = createBrowserBibliography(localStorage, files);
  const binding = await initial.bindCitation("project", {literatureItemId: item.id, requestedKey: "stable2026", bibtexEntry: "@article{stable2026,title={Synthetic},year={2026}}"});
  const storedBindings = localStorage.getItem("citation-bindings"), storedRows = localStorage.getItem("project-bibliography");
  availability.available = false; availability.get.mockClear(); availability.list.mockClear();
  const absent = createBrowserBibliography(localStorage, files);
  await absent.syncBibliography("project", []);
  expect(await absent.listCitationBindings("project")).toEqual([binding]);
  const entries = await absent.listBibliographyEntries("project", true);
  expect(entries.map(value => value.citationKey)).toEqual(["local2025", "stable2026"]);
  expect(entries.find(value => value.id === `binding:${item.id}`)?.libraryItemId).toBe(item.id);
  expect(records.get("references.bib")?.content).toContain("stable2026");
  expect(localStorage.getItem("citation-bindings")).toBe(storedBindings);
  expect(localStorage.getItem("project-bibliography")).toBe(storedRows);
  expect(localStorage.getItem("unrelated-conversation-draft")).toBe("unsent input");
  expect(availability.get).not.toHaveBeenCalled(); expect(availability.list).not.toHaveBeenCalled();
  await expect(absent.searchCitations("project", "", "library")).rejects.toThrow("literature_citations_unavailable");
  availability.available = true;
  const restored = createBrowserBibliography(localStorage, files);
  expect((await restored.searchCitations("project", "", "library"))[0]?.literatureItemId).toBe(item.id);
  expect((await restored.listBibliographyEntries("project", true)).find(value => value.id === `binding:${item.id}`)?.libraryItem?.id).toBe(item.id);
  expect(await restored.listCitationBindings("project")).toEqual([binding]);
});
