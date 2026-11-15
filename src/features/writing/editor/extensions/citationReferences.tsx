import { EditorSelection, EditorState, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import { InlineReference } from "@research-assistant/workbench-sdk/ui";
import type { WritingCitationLabel } from "../../citations/citationLabels";
import "./citationReferences.css";
import { refreshCitationIdentity } from "./citationIdentity";

export const refreshCitationReferences = refreshCitationIdentity;
interface ReferenceRange { readonly from: number; readonly to: number; readonly label: WritingCitationLabel }
interface References { readonly ranges: readonly ReferenceRange[]; readonly decorations: DecorationSet }
type CitationDOM = HTMLSpanElement & { referenceRoot?: Root };

class CitationWidget extends WidgetType {
  constructor(readonly label: WritingCitationLabel) { super(); }
  override eq(other: CitationWidget): boolean { return JSON.stringify(this.label) === JSON.stringify(other.label); }
  toDOM(view: EditorView): HTMLElement {
    const dom: CitationDOM = document.createElement("span");
    dom.contentEditable = "false";
    const root = createRoot(dom);
    dom.referenceRoot = root;
    const prefix = `(${this.label.author}, ${this.label.issuedYear ?? "无年份"}${this.label.yearSuffix ?? ""})`;
    const label = `${prefix} ${this.label.title}`;
    const title = this.label.title.trim();
    const titleWord = title.match(/\S+/u)?.[0] ?? "";
    const titlePreview = titleWord + (title.length > titleWord.length ? "…" : "");
    root.render(<InlineReference label={label} title={`${label}\n${this.label.citationKey}`}
      className="writing-citation-reference" data-citation-key={this.label.citationKey}
      data-reference-id={this.label.referenceId}
      ref={element => {if (element && view.dom.isConnected) view.requestMeasure();}}
      labelContent={<><span className="writing-citation-author">{prefix}</span><span className="writing-citation-title">{titlePreview}</span></>} />);
    dom.addEventListener("mousedown", event => event.preventDefault());
    dom.addEventListener("click", () => {
      const from = view.posAtDOM(dom);
      view.dispatch({selection: {anchor: from, head: from + this.label.citationKey.length}});
      view.focus();
    });
    return dom;
  }
  override destroy(dom: HTMLElement): void {
    const element = dom as CitationDOM, root = element.referenceRoot;
    // CodeMirror can destroy widgets during a parent React commit. Release the
    // independent root after that commit rather than synchronously unmounting it.
    if (root) {delete element.referenceRoot; queueMicrotask(() => root.unmount());}
  }
  override ignoreEvent(): boolean { return true; }
}

/** Presentation replaces only known keys, never the underlying LaTeX source. */
export function citationReferenceExtensions(getLabels: () => readonly WritingCitationLabel[]): Extension {
  function decorate(state: EditorState): References {
    const labels = new Map(getLabels().map(label => [label.citationKey, label]));
    const ranges: ReferenceRange[] = [];
    if (labels.size) {
      // Mask comments and literal environments without changing source offsets.
      const source = state.doc.toString()
        .replace(/(?<!\\)(?:\\\\)*%[^\n]*/gu, value => " ".repeat(value.length))
        .replace(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/gu, value => " ".repeat(value.length))
        .replace(/\\verb\*?([^\sA-Za-z])[\s\S]*?\1/gu, value => " ".repeat(value.length));
      const command = /(?<!\\)\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{/gu;
      for (const match of source.matchAll(command)) {
        let offset = (match.index ?? 0) + match[0].length;
        // A managed key remains a tag while its argument's closing brace is
        // temporarily absent. Parse keys, rather than requiring a whole group.
        while (offset < source.length) {
          offset += /^\s*/u.exec(source.slice(offset))?.[0].length ?? 0;
          const key = /^[^\s,{}\\]+/u.exec(source.slice(offset))?.[0];
          if (!key) break;
          const label = labels.get(key);
          if (label) ranges.push({from: offset, to: offset + key.length, label});
          offset += key.length;
          offset += /^\s*/u.exec(source.slice(offset))?.[0].length ?? 0;
          if (source[offset] !== ",") break;
          offset++;
        }
      }
    }
    return {ranges, decorations: Decoration.set(ranges.map(range => Decoration.replace({widget: new CitationWidget(range.label)}).range(range.from, range.to)), true)};
  }
  const references = StateField.define<References>({
    create: decorate,
    update: (value, transaction) => transaction.docChanged || transaction.effects.some(effect => effect.is(refreshCitationReferences))
      ? decorate(transaction.state) : value,
    provide: field => [EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of(view => view.state.field(field).decorations)],
  });
  const wholeReferences = EditorState.transactionFilter.of(transaction => {
    // Agent/restore/CAS operations retain their exact source ranges. Ordinary
    // typing, cut and paste expand partial tag edits to the complete source key.
    if (transaction.isUserEvent("input.agent") || transaction.isUserEvent("input.restore")
      || (!transaction.isUserEvent("input") && !transaction.isUserEvent("delete"))) return transaction;
    const ranges = transaction.startState.field(references, false)?.ranges ?? [];
    const changes: {from: number; to: number; insert: string}[] = [];
    let expanded = false;
    transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
      const start = from, end = to;
      for (const range of ranges) if (from < range.to && to > range.from || from === to && from > range.from && from < range.to) {
        from = Math.min(from, range.from); to = Math.max(to, range.to);
      }
      expanded ||= start !== from || end !== to;
      const previous = changes.at(-1);
      if (previous && from < previous.to) { previous.to = Math.max(previous.to, to); previous.insert += insert.toString(); }
      else changes.push({from, to, insert: insert.toString()});
    });
    if (!expanded) return transaction;
    const changeSet = transaction.startState.changes(changes);
    return {changes: changeSet, selection: EditorSelection.create(changes.map(change => EditorSelection.cursor(changeSet.mapPos(change.from, -1) + change.insert.length))),
      effects: transaction.effects, scrollIntoView: transaction.scrollIntoView,
      annotations: [Transaction.userEvent.of(transaction.annotation(Transaction.userEvent) ?? "input"),
        Transaction.addToHistory.of(transaction.annotation(Transaction.addToHistory) !== false)]};
  });
  return [references, wholeReferences];
}
