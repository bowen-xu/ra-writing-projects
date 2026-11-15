import { editorSearchScope } from "@research-assistant/workbench-sdk/code-editor-extensions";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { WritingDocumentContent } from "@research-assistant/writing";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, Text, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  type ViewUpdate,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { getOriginalDoc, unifiedMergeView } from "@codemirror/merge";

import { latexLanguage } from "@research-assistant/workbench-sdk/code-editor-extensions";
import { bibtexLanguage } from "./extensions/bibtexLanguage";
import { latexCompletion, type LatexCompletionData } from "./extensions/latexCompletion";
import { citationReferenceExtensions } from "./extensions/citationReferences";
import { citationCatalog, citationIdentityExtensions, citationInsertion } from "./extensions/citationIdentity";
import { writingKeymap } from "./writingKeymap";
import { createWritingSearchPanel } from "./writingSearchPanel";
import { editorPreferencesCompartment, editorPreferenceExtensions, readEditorPreferences, type EditorPreferences } from "./editorPreferences";
import { codeCheckCompartment, codeCheckExtension } from "./code-check/codeCheck";
import { compileDiagnosticsCompartment, compileDiagnosticsExtension } from "./compileDiagnostics";
import { writingEditorIdentity } from "./editorSession";
import { writingReviewBaseline } from "./writingReviewBaseline";
import { chunkActionDecorations } from "@research-assistant/workbench-sdk/editor-review";

export interface LatexEditorDiffOptions {
  readonly before: string;
  readonly after: string;
  readonly onResolveChunk?: (view: EditorView, position: number, action: "keep" | "undo") => void;
}

export interface EditorStateOptions {
  readonly filePath?: string;
  readonly content: string;
  /** Restored file checkpoints initialize D and B without replaying an edit. */
  readonly reviewBaseline?: string;
  readonly onChange: (content: string) => void;
  readonly onDocumentChange?: (document: WritingDocumentContent) => void;
  readonly onCompile: () => void;
  readonly onOpenCommands: () => void;
  readonly onCursorChange: (offset: number) => void;
  readonly getCompletionData: () => LatexCompletionData;
  readonly initialCursor?: number;
  readonly preferences?: EditorPreferences;
  readonly codeCheckEnabled?: boolean;
  readonly onCodeCheckResult?: (hasErrors: boolean) => void;
  readonly diff?: LatexEditorDiffOptions;
  readonly onUpdate?: (update: ViewUpdate) => void;
}

/** View callbacks are replaceable without replacing file-owned history. */
export const editorHostCompartment = new Compartment();

export function editorHostExtensions(options: EditorStateOptions): Extension {
  const isBibliographyProjection = options.filePath?.toLowerCase().endsWith(".bib") === true;
  return [
    citationCatalog.of(() => (options.getCompletionData().citationReferences ?? []).map(row => ({referenceId:row.referenceId ?? row.citationKey,citationKey:row.citationKey}))),
    options.filePath?.toLowerCase().endsWith(".bib") ? [] : latexCompletion(options.getCompletionData),
    options.filePath?.toLowerCase().endsWith(".bib") ? [] : citationReferenceExtensions(() => options.getCompletionData().citationReferences ?? []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !isBibliographyProjection) options.onChange(update.state.doc.toString());
      if (!isBibliographyProjection && (update.docChanged || !getOriginalDoc(update.startState).eq(getOriginalDoc(update.state)))) {
        options.onDocumentChange?.({ content: update.state.doc.toString(), reviewBaseline: getOriginalDoc(update.state).toString() });
      }
      if (update.selectionSet) options.onCursorChange(update.state.selection.main.head);
      options.onUpdate?.(update);
    }),
    writingKeymap(options),
    ...(options.diff?.onResolveChunk === undefined ? [] : [chunkActionDecorations(options.diff.onResolveChunk)]),
  ];
}

export function createLatexEditorState(options: EditorStateOptions): EditorState {
  const diff = options.diff;
  const extensions: Extension[] = [
    ...(options.filePath?.toLowerCase().endsWith(".bib")
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    writingEditorIdentity,
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    editorPreferencesCompartment.of(editorPreferenceExtensions(options.preferences ?? readEditorPreferences(null))),
    codeCheckCompartment.of(codeCheckExtension(options.codeCheckEnabled !== false, options.onCodeCheckResult ?? (() => {}))),
    compileDiagnosticsCompartment.of(compileDiagnosticsExtension([])),
    highlightActiveLineGutter(),
    foldGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    options.filePath?.toLowerCase().endsWith(".bib") ? bibtexLanguage : latexLanguage(),
    editorSearchScope,
    search({ createPanel: createWritingSearchPanel, literal: true }),
    editorHostCompartment.of(editorHostExtensions(options)),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    // The baseline field and its history remain installed even when B === D.
    // Turning Diff presentation on/off must not replace the editor state.
    Prec.high(EditorView.domEventHandlers({ copy: (event, view) => copyDeletedSelection(event, view) })),
    writingReviewBaseline,
    unifiedMergeView({ original: Text.of((options.reviewBaseline ?? diff?.before ?? options.content).split("\n")), mergeControls: false,
      syntaxHighlightDeletions: false, allowInlineDiffs: false, diffConfig: { scanLimit: 1000, timeout: 50 } }),
    citationIdentityExtensions, citationInsertion,
    EditorView.editorAttributes.of((view) => getOriginalDoc(view.state).length === 0
      ? { class: "cm-empty-review-baseline" } : null),
    EditorView.theme({
      "&": { height: "100%", backgroundColor: "#fffefb", color: "#263029" },
      ".cm-scroller": { overflow: "auto", fontFamily: '"SFMono-Regular", Consolas, monospace', fontSize: "13px", lineHeight: "1.65" },
      ".cm-content": { padding: "18px 0", caretColor: "#2f6042" },
      // An empty original document still has one virtual line. Merge may
      // render it as <del><br></del> when the new text has no final newline.
      // Real deleted blank lines have a nonempty baseline and stay visible.
      ".cm-deletedChunk:empty, &.cm-empty-review-baseline .cm-deletedChunk": { display: "none" },
      ".cm-gutters": { backgroundColor: "#f6f5f0", color: "#9ba099", borderRight: "1px solid #e1e0da" },
      ".cm-activeLine": { backgroundColor: "#edf2eb80" },
      ".cm-activeLineGutter": { backgroundColor: "#e6ece4", color: "#52685a" },
      ".cm-selectionBackground, ::selection": { backgroundColor: "#cddfce !important" },
      "&.cm-focused": { outline: "none" },
    }),
  ];

  const initialContent = diff?.before ?? options.content;
  const anchor = Math.min(Math.max(options.initialCursor ?? 0, 0), initialContent.length);
  return EditorState.create({ doc: Text.of(initialContent.split("\n")), selection: { anchor }, extensions });
}

function copyDeletedSelection(event: Event, view: EditorView): boolean {
  const selection = view.dom.ownerDocument.getSelection();
  const anchor = selection?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (!selection || selection.isCollapsed || !element?.closest(".cm-deletedChunk")) return false;
  const text = selection.toString();
  const clipboard = (event as ClipboardEvent).clipboardData;
  if (!text || !clipboard) return false;
  clipboard.setData("text/plain", text);
  event.preventDefault();
  return true;
}
