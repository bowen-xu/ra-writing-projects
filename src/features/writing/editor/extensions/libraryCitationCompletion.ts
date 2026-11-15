import { closeCompletion, insertCompletionText, pickedCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSection } from "@codemirror/autocomplete";
import { createStableCitationKey, type CitationCandidate } from "@research-assistant/writing";
import { writingEditorIdentity } from "../editorSession";
import { citationInsertion, markCitationInsertion } from "./citationIdentity";
import "./libraryCitationCompletion.css";

const librarySection: CompletionSection = {name: "源自文献库"};

/** The workspace owns I/O; the editor only searches and accepts a selection. */
export interface LibraryCitationCompletion {
  search(query: string): Promise<readonly CitationCandidate[]>;
  bind(candidate: CitationCandidate): Promise<string>;
  onError(reason: unknown): void;
}

export async function libraryCitationCompletions(context: CompletionContext, from: number, query: string,
  keys: readonly string[], library: LibraryCitationCompletion): Promise<CompletionResult | null> {
  if (!query.trim()) return null;
  let candidates: readonly CitationCandidate[];
  try { candidates = await library.search(query.trim()); }
  catch (reason) { if (!context.aborted) library.onError(reason); candidates = []; }
  if (context.aborted) return null;
  const occupied = new Set(keys);
  const described = new Set(candidates.flatMap(candidate => candidate.citationKey ? [candidate.citationKey] : []));
  const needle = query.trim().toLowerCase();
  const local = keys.filter(key => !described.has(key) && key.toLowerCase().includes(needle))
    .map(label => ({label, type: "constant", detail: "稿件参考文献"}));
  const options: Completion[] = candidates.map(candidate => {
      const key = candidate.citationKey ?? createStableCitationKey({importedKey: candidate.importedKey,
        firstAuthor: candidate.firstAuthor, title: candidate.title,
        ...(candidate.issuedYear === undefined ? {} : {issuedYear: candidate.issuedYear})}, occupied);
      return {
        label: key,
        displayLabel: candidate.title,
        type: "reference",
        detail: [candidate.firstAuthor, candidate.issuedYear, key].filter(Boolean).join(" · "),
        ...(candidate.citationKey ? {} : {section: librarySection}),
        apply(view, completion, start, end) {
          const state = view.state, identity = state.field(writingEditorIdentity);
          const token = {};
          view.dispatch({effects:markCitationInsertion.of({token,from:start,to:end})});
          closeCompletion(view);
          // Do not write a provisional key. Native binding may choose a pinned
          // import key or resolve a collision before the managed file is ready.
          void library.bind(candidate).then(key => {
            if (!view.dom.isConnected) return;
            const current = view.state.field(writingEditorIdentity);
            if (current.sessionId !== identity.sessionId) return;
            const bookmark = view.state.field(citationInsertion);
            if (!bookmark || bookmark.token !== token) {
              library.onError(new Error("文献已加入参考文献，正文已变化，请重新选择引用插入位置。"));
              return;
            }
            view.dispatch({...insertCompletionText(view.state, key, bookmark.from, bookmark.to), effects:markCitationInsertion.of(null), annotations: pickedCompletion.of(completion)});
          }).catch(reason => library.onError(reason));
        },
      } satisfies import("@codemirror/autocomplete").Completion;
    });
  // Search already matches title/author/year/key. CodeMirror's key-only fuzzy
  // filter would hide a title match whose citation key does not contain query.
  return {from, options: [...local, ...options.filter(option => !option.section), ...options.filter(option => option.section)], filter: false};
}
