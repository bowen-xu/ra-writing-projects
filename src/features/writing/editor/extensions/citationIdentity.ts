import { Facet, StateEffect, StateField, Transaction, EditorState, ChangeSet, type Extension } from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { getOriginalDoc, originalDocChangeEffect } from "@codemirror/merge";
import { citationKeyRanges, type CitationKeyAssignment } from "@research-assistant/writing";
import { writingTextChanges } from "../writingDiffCommands";

export interface CitationIdentity { readonly referenceId: string; readonly citationKey: string }
interface Occurrence { readonly referenceId: string; readonly from: number; readonly to: number; readonly key?: string }
interface Snapshot { readonly document: readonly Occurrence[]; readonly baseline: readonly Occurrence[] }
interface Identities extends Snapshot { readonly names: ReadonlyMap<string, string> }
export const citationCatalog = Facet.define<() => readonly CitationIdentity[]>();
export const refreshCitationIdentity = StateEffect.define<null>();
export const citationKeyMigration = StateEffect.define<readonly CitationKeyAssignment[]>();
interface HistoryIdentity {readonly referenceId:string;readonly at:number;readonly offset?:number;readonly key?:string}
interface HistorySnapshot {readonly document:readonly HistoryIdentity[];readonly baseline:readonly Occurrence[]}
const restoreIdentities = StateEffect.define<HistorySnapshot>({map(value, changes) {
  return {...value,document:value.document.map(range => ({...range,at:changes.mapPos(range.at,range.offset === undefined ? 1 : -1)}))};
}});

function occurrences(text: string, names: ReadonlyMap<string,string>, previous: readonly Occurrence[] = [], historical: readonly Occurrence[] = []): readonly Occurrence[] {
  const byKey = new Map([...names].map(([id,key]) => [key,id]));
  return citationKeyRanges(text).flatMap(range => {
    const restored = previous.find(item => item.from === range.from);
    const referenceId = restored?.referenceId ?? historical.find(item => item.key === range.key)?.referenceId ?? byKey.get(range.key);
    return referenceId ? [{referenceId,from:range.from,to:range.to,key:range.key}] : [];
  });
}
const namesIn = (state: EditorState, previous: ReadonlyMap<string,string>) => {
  const names = new Map(previous);
  for (const get of state.facet(citationCatalog)) for (const row of get()) names.set(row.referenceId,row.citationKey);
  return names;
};
export const citationIdentities = StateField.define<Identities>({
  create(state) {
    const names = namesIn(state, new Map());
    return {names,document:occurrences(state.doc.toString(),names),baseline:occurrences(getOriginalDoc(state).toString(),names)};
  },
  update(value, tr) {
    const originalBefore = getOriginalDoc(tr.startState), originalAfter = getOriginalDoc(tr.state);
    if (!tr.docChanged && !tr.reconfigured && originalBefore.eq(originalAfter)
      && !tr.effects.some(effect => effect.is(refreshCitationIdentity) || effect.is(citationKeyMigration) || effect.is(restoreIdentities))) return value;
    const names = tr.reconfigured || tr.effects.some(effect => effect.is(refreshCitationIdentity))
      ? namesIn(tr.state, value.names) : new Map(value.names);
    for (const effect of tr.effects) if (effect.is(citationKeyMigration)) for (const row of effect.value) names.set(row.referenceId,row.to);
    const histories:HistorySnapshot[] = [];
    for (const effect of tr.effects) if (effect.is(restoreIdentities)) histories.push(effect.value);
    const restoredDocument = histories.flatMap(history => history.document.map(item => ({referenceId:item.referenceId,
      from:tr.changes.mapPos(item.at,item.offset === undefined ? 1 : -1) + (item.offset ?? 0),to:0})));
    const historicalDocument = histories.flatMap(history => history.document.map(item => ({referenceId:item.referenceId,from:0,to:0,...(item.key ? {key:item.key} : {})})));
    const mapped = value.document.filter(range => !tr.changes.touchesRange(range.from,range.to))
      .map(range => ({...range,from:tr.changes.mapPos(range.from,1),to:tr.changes.mapPos(range.to,-1)}));
    // A historical merge effect may carry a changeset in the old baseline's
    // coordinates. Map IDs using the actual before/after baseline documents.
    const originalChanges = originalBefore.eq(originalAfter) ? undefined : writingTextChanges(originalBefore.toString(),originalAfter.toString());
    const mappedBaseline = originalChanges ? value.baseline.filter(range => !originalChanges.touchesRange(range.from,range.to))
      .map(range => ({...range,from:originalChanges.mapPos(range.from,1),to:originalChanges.mapPos(range.to,-1)})) : value.baseline;
    return {names,document:occurrences(tr.newDoc.toString(),names,[...mapped,...restoredDocument],historicalDocument),
      baseline:occurrences(getOriginalDoc(tr.state).toString(),names,mappedBaseline,histories.flatMap(history => history.baseline))};
  },
});

function changesFor(text: string, ranges: readonly Occurrence[], names: ReadonlyMap<string,string>) {
  return ranges.flatMap(range => {
    const insert = names.get(range.referenceId);
    return insert && text.slice(range.from,range.to) !== insert ? [{from:range.from,to:range.to,insert}] : [];
  });
}

/** Retain ID provenance in history. Undo restores a reference, not an obsolete label. */
export const citationIdentityExtensions: Extension = [citationIdentities,
  invertedEffects.of(tr => {
    if (!tr.docChanged && getOriginalDoc(tr.startState).eq(getOriginalDoc(tr.state))) return [];
    const value = tr.startState.field(citationIdentities);
    const document = value.document.map(item => {
      let offset:number | undefined;
      tr.changes.iterChangedRanges((from,to) => {if (from <= item.from && item.from < to) offset = item.from - from;});
      return {referenceId:item.referenceId,at:tr.changes.mapPos(item.from,offset === undefined ? 1 : -1),...(offset === undefined ? {} : {offset}),...(item.key ? {key:item.key} : {})};
    });
    return [restoreIdentities.of({document,baseline:value.baseline})];
  }),

];

/** CodeMirror history deliberately sets filter:false. The file session appends
 * this normalization to the same accepted batch, before save/checkpoint listeners. */
export function canonicalCitationTransaction(state:EditorState) {
  const value = state.field(citationIdentities);
  const changes = changesFor(state.doc.toString(),value.document,value.names);
  const original = getOriginalDoc(state);
  const baseline = changesFor(original.toString(),value.baseline,value.names);
  if (!changes.length && !baseline.length) return undefined;
  return {changes,effects:originalDocChangeEffect(state,ChangeSet.of(baseline,original.length)),
    annotations:[Transaction.addToHistory.of(false),isolateHistory.of("full"),Transaction.userEvent.of("input.citation-key")]};
}

/** A system rename changes both sides of review and creates no user undo step. */
export function citationMigrationTransaction(state: EditorState, assignments: readonly CitationKeyAssignment[]) {
  const identity = state.field(citationIdentities);
  const before = new Map(assignments.map(row => [row.referenceId,row.from]));
  const after = new Map(assignments.map(row => [row.referenceId,row.to]));
  const changes = (text:string, previous:readonly Occurrence[]) => changesFor(text,occurrences(text,before,previous),after);
  const original = getOriginalDoc(state);
  return {changes:changes(state.doc.toString(),identity.document), effects:[citationKeyMigration.of(assignments),
    originalDocChangeEffect(state,ChangeSet.of(changes(original.toString(),identity.baseline),original.length))],
    annotations:[Transaction.addToHistory.of(false),Transaction.userEvent.of("input.citation-key")]};
}

// A pending completion may move when earlier citation tags are renamed. User
// edits still invalidate it; only system key migrations may map its insertion.
interface Bookmark { readonly token: object; readonly from: number; readonly to: number }
export const markCitationInsertion = StateEffect.define<Bookmark | null>();
export const citationInsertion = StateField.define<Bookmark | null>({
  create: () => null,
  update(value,tr) {
    for (const effect of tr.effects) if (effect.is(markCitationInsertion)) return effect.value;
    if (!value) return null;
    if ((tr.docChanged || tr.selection) && !tr.isUserEvent("input.citation-key")) return null;
    return {...value,from:tr.changes.mapPos(value.from,1),to:tr.changes.mapPos(value.to,-1)};
  },
});
