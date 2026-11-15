// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseBibtex } from "@research-assistant/core/citation";
import type { LiteratureItem } from "@research-assistant/core/literature";
import type { CitationCandidate } from "@research-assistant/writing";
import type { LiteratureGateway } from "@research-assistant/data/literature";
import type { WritingGateway } from "./gateway";
import { useWritingCitations } from "./useWritingCitations";

const item: LiteratureItem = {id: "library", itemType: "journalArticle", title: "Synthetic library article", abstractText: "", issuedYear: 2026,
  containerTitle: "Journal", volume: "", issue: "", pages: "", doi: "", url: "", language: "", bibtexKey: "Library2026",
  creators: [{familyName: "Example", givenName: "Alice", literalName: "", role: "author"}], tags: [], attachments: [],
  readingStatus: "unread", projectIds: [], metadataSources: [], createdAt: "now", updatedAt: "now"};
const candidate: CitationCandidate = {literatureItemId: item.id, title: item.title, firstAuthor: "Example", importedKey: item.bibtexKey,
  containerTitle: "Journal", hasPdf: false, hasEvidence: false, warnings: []};

async function harness() {
  const root = createRoot(document.createElement("div"));
  const binding = {manuscriptId: "m", literatureItemId: item.id, citationKey: "ExistingPinnedKey", bibtexEntry: "", state: "active", pinnedAt: "now", updatedAt: "now"};
  const gateway = {bindCitation: vi.fn().mockResolvedValue(binding), listCitationBindings: vi.fn().mockResolvedValue([binding]),
    getBibliographyStatus: vi.fn().mockResolvedValue({status: "ready"}), listFiles: vi.fn().mockResolvedValue([]), searchCitations: vi.fn().mockResolvedValue([candidate])};
  const insert = vi.fn(), mark = vi.fn();
  let citations!: ReturnType<typeof useWritingCitations>;
  function Host({path}: {path: string}) {
    citations = useWritingCitations({activeManuscriptId: "m", activePath: path, gateway: gateway as unknown as WritingGateway,
      literatureGateway: {get: vi.fn().mockResolvedValue(item)} as unknown as LiteratureGateway, citationBindings: [], compiler: {markSourceChanged: mark},
      setCitationBindings: vi.fn(), setBibliographyStatus: vi.fn(), setFiles: vi.fn(), setInsertionRequest: insert, setError: vi.fn()});
    return null;
  }
  const render = (path: string) => act(async () => root.render(<Host path={path}/>));
  await render("main.tex");
  return {gateway, insert, mark, render, citations: () => citations, dispose: () => act(async () => root.unmount())};
}

it("binds an external library item before inserting and uses the canonical manuscript key", async () => {
  const host = await harness();
  try {
    await act(async () => host.citations().insertCitations([candidate]));
    const request = host.gateway.bindCitation.mock.calls[0]?.[1];
    expect(host.gateway.bindCitation).toHaveBeenCalledWith("m", expect.objectContaining({literatureItemId: item.id}));
    expect(parseBibtex(request.bibtexEntry)[0]?.bibtexKey).toBe("library2026");
    expect(host.insert).toHaveBeenCalledWith(expect.objectContaining({text: "\\cite{ExistingPinnedKey}"}));
    expect(host.mark).toHaveBeenCalledOnce();
    host.insert.mockClear();
    expect(await host.citations().bindCitation(candidate)).toBe("ExistingPinnedKey");
    expect(host.insert).not.toHaveBeenCalled();
  } finally {await host.dispose();}
});

it("never inserts a key after publication fails or a pending request loses its target", async () => {
  const host = await harness();
  try {
    host.gateway.bindCitation.mockRejectedValueOnce(new Error("cannot write bib"));
    await expect(host.citations().insertCitations([candidate])).rejects.toThrow("cannot write bib");
    let finish!: (value: unknown) => void;
    host.gateway.bindCitation.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const pending = host.citations().insertCitations([candidate]);
    const failure = expect(pending).rejects.toThrow("引用目标已切换");
    await vi.waitFor(() => expect(host.gateway.bindCitation).toHaveBeenCalledTimes(2));
    await host.render("other.tex"); finish({citationKey: "late"}); await failure;
    expect(host.insert).not.toHaveBeenCalled(); expect(host.mark).not.toHaveBeenCalled();
    await host.render("references.bib");
    await expect(host.citations().insertCitations([candidate])).rejects.toThrow("源码");
  } finally {await host.dispose();}
});
