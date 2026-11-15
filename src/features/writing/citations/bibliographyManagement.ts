import type { LiteratureDraft, LiteratureItem } from "@research-assistant/core/literature";
import type { ProjectBibliographyEntry } from "@research-assistant/writing";
import type { LiteratureGateway } from "@research-assistant/data/literature";
import type { WritingGateway } from "../gateway";

function token(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }
function doi(value: string): string { return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").replace(/^doi:\s*/iu, "").toLowerCase(); }
/** Ambiguous records remain local. A DOI disagreement is never a title match. */
function bibliographyMatches(draft: LiteratureDraft, library: readonly LiteratureItem[]): readonly LiteratureItem[] {
  const active = library.filter(item => !item.trashedAt);
  const exact = draft.doi ? active.filter(item => doi(item.doi) === doi(draft.doi)) : [];
  if (exact.length) return exact;
  const author = (item: LiteratureDraft) => token(item.creators[0]?.familyName || item.creators[0]?.literalName || "");
  const candidates = active.filter(item => (!draft.doi || !item.doi)
    && token(item.title) === token(draft.title) && (item.issuedYear ?? null) === (draft.issuedYear ?? null)
    && author(draft) && author(item) === author(draft));
  return candidates;
}

export function matchBibliographyItem(draft: LiteratureDraft, library: readonly LiteratureItem[]): LiteratureItem | undefined {
 const matches=bibliographyMatches(draft,library);return matches.length===1?matches[0]:undefined;
}

/** Called only by explicit single/batch promotion, never by import or render.
 * Recheck the library between rows: duplicates in a batch reuse the first item.
 * Link each success immediately; a partial batch stays visible and retryable.
 */
export async function promoteBibliographyEntries(entries: readonly ProjectBibliographyEntry[], literature: Pick<LiteratureGateway, "list" | "save">, writing: WritingGateway): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    if (entry.libraryItem || entry.libraryItemId || entry.id.startsWith("binding:")) continue;
    const draft = { ...entry.current, bibtexKey: entry.citationKey };
    const library = await literature.list();
    const candidates=bibliographyMatches(draft,library);
    const created=library.find(item=>item.id===entry.id);
    if(!created && candidates.length>1)throw new Error("文献库中有多条匹配记录，请先核对合并后重试。项目条目已保留。");
    const item = created ?? candidates[0] ?? await literature.save({...draft,id:entry.id});
    await writing.linkBibliographyEntry(entry.manuscriptId, entry.id, item.id);
    count += 1;
  }
  return count;
}
