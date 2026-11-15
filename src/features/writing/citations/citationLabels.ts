import type { ProjectBibliographyEntry } from "@research-assistant/writing";

export interface WritingCitationLabel {
  readonly referenceId?: string;
  readonly yearSuffix?: string;
  readonly citationKey: string;
  readonly author: string;
  readonly issuedYear?: number;
  readonly title: string;
}

/** Project-only and library-linked entries share the same display boundary. */
export function citationLabels(entries: readonly ProjectBibliographyEntry[]): readonly WritingCitationLabel[] {
  return entries.map(entry => {
    const item = entry.libraryItem ?? entry.current;
    const authors = item.creators.filter(person => person.role === "author");
    const first = authors[0];
    const name = first?.literalName || first?.familyName || first?.givenName || "未知作者";
    const suffix = entry.baseKey && entry.citationKey.startsWith(`${entry.baseKey}:`)
      ? entry.citationKey.slice(entry.baseKey.length + 1) : "";
    return {referenceId:entry.id, citationKey: entry.citationKey, title: item.title,
      ...(suffix && /^[a-z]+$/u.test(suffix) && !suffix.startsWith("unused") ? {yearSuffix:suffix} : {}),
      author: authors.length > 1 ? `${name} 等` : name,
      ...(item.issuedYear === undefined ? {} : {issuedYear: item.issuedYear})};
  });
}
