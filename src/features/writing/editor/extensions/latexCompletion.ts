import {
  pickedCompletion,
  acceptCompletion, clearSnippet, closeCompletion, nextSnippetField, prevSnippetField, snippetKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { findLatexCompletionContext } from "@research-assistant/writing";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { libraryCitationCompletions, type LibraryCitationCompletion } from "./libraryCitationCompletion";
import type { WritingCitationLabel } from "../../citations/citationLabels";
import { environmentCommandOptions, environmentCompletions } from "./environmentCompletion";
import { virtualCompletion } from "@research-assistant/workbench-sdk/code-editor-extensions";

export interface LatexCompletionData {
  readonly citationKeys: readonly string[];
  readonly files: readonly string[];
  readonly labels: readonly string[];
  readonly libraryCitations?: LibraryCitationCompletion;
  readonly citationReferences?: readonly WritingCitationLabel[];
}

const COMMANDS: readonly Completion[] = [
  { label: "section", type: "keyword", detail: "section heading" },
  { label: "subsection", type: "keyword", detail: "subsection heading" },
  { label: "subsubsection", type: "keyword", detail: "subsubsection heading" },
  { label: "paragraph", type: "keyword" },
  { label: "begin", type: "keyword", detail: "begin environment" },
  { label: "end", type: "keyword", detail: "end environment" },
  { label: "label", type: "keyword" },
  { label: "ref", type: "keyword" },
  { label: "eqref", type: "keyword" },
  { label: "autoref", type: "keyword" },
  { label: "cite", type: "keyword" },
  { label: "parencite", type: "keyword" },
  { label: "textcite", type: "keyword" },
  { label: "input", type: "keyword" },
  { label: "include", type: "keyword" },
  { label: "includegraphics", type: "keyword" },
  { label: "caption", type: "keyword" },
  { label: "item", type: "keyword" },
  { label: "emph", type: "keyword" },
  { label: "textbf", type: "keyword" },
  { label: "textit", type: "keyword" },
  { label: "footnote", type: "keyword" },
  { label: "url", type: "keyword" },
  { label: "usepackage", type: "keyword" },
  { label: "documentclass", type: "keyword" },
].map(command => command.label === "item" ? command : {...command, apply: applyArgumentCommand});

function applyArgumentCommand(view: EditorView, command: Completion, from: number, to: number): void {
  const state = view.state, main = state.selection.main;
  const fromOffset = from - main.from, toOffset = to - main.from;
  view.dispatch({...state.changeByRange(range => {
    const start = range.from + fromOffset, end = range.from + toOffset;
    if (range !== main && state.sliceDoc(start, end) !== state.sliceDoc(from, to)) return {range};
    // Preserve arguments already present after the completed command.
    const existingArgument = ["{", "["].includes(state.sliceDoc(end, end + 1));
    const insert = command.label + (existingArgument ? "" : "{}");
    return {changes: {from: start, to: end, insert},
      range: EditorSelection.cursor(start + command.label.length + 1)};
  }), annotations: pickedCompletion.of(command), userEvent: "input.complete", scrollIntoView: true});
}

export function latexCompletion(getData: () => LatexCompletionData): Extension {
  // Autocompletion's own highest-priority Escape would otherwise consume a
  // pending query without releasing the active environment fields.
  const closeEditing = (view: EditorView) => {const closed = closeCompletion(view); return clearSnippet(view) || closed;};
  return [Prec.highest(keymap.of([{key: "Escape", run: closeEditing}])), snippetKeymap.of([
    {key: "Tab", run: view => acceptCompletion(view) || nextSnippetField(view), shift: prevSnippetField},
    {key: "Escape", run: closeEditing},
  ]), virtualCompletion({
    activateOnTyping: true,
    interactionDelay: 0,
    tooltipClass: state => {
      const position = state.selection.main.head;
      const before = state.sliceDoc(Math.max(0, position - 600), position);
      return findLatexCompletionContext(before, before.length)?.kind === "citation" ? "writing-citation-completions" : "";
    },
    override: [(context) => completeLatex(context, getData())],
  })];
}

function completeLatex(
  context: CompletionContext,
  data: LatexCompletionData,
): CompletionResult | null | Promise<CompletionResult | null> {
  const environment = environmentCompletions(context);
  if (environment) return environment;
  const start = Math.max(0, context.pos - 600);
  const source = context.state.sliceDoc(start, context.pos);
  const completion = findLatexCompletionContext(source, source.length);
  if (completion === undefined) return null;
  if (completion.kind === "citation" && !completion.prefix.trim()) return null;
  if (completion.kind === "citation" && data.libraryCitations) {
    return libraryCitationCompletions(context, start + completion.from, source.slice(completion.from), data.citationKeys, data.libraryCitations);
  }
  const values = completion.kind === "command"
    ? [...COMMANDS, ...environmentCommandOptions(context)]
    : completion.kind === "environment"
      ? []
      : completion.kind === "label"
        ? data.labels.map((label) => ({ label, type: "constant" }))
        : completion.kind === "citation"
          ? data.citationKeys.map((label) => ({ label, type: "constant" }))
          : data.files.map((label) => ({ label, type: "text" }));
  return {
    from: start + completion.from,
    options: uniqueCompletions(values),
    validFor: completion.kind === "command"
      ? /^[A-Za-z@]*$/u
      : /^[^,{}]*$/u,
  };
}

function uniqueCompletions(values: readonly Completion[]): readonly Completion[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.label)) return false;
    seen.add(value.label);
    return true;
  });
}
