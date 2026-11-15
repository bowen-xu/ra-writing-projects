import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { deleteLine, indentLess, redo } from "@codemirror/commands";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";
import { gotoLine } from "@codemirror/search";
import { EditorView, keymap, ViewPlugin, type KeyBinding } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";

import {
  changeWritingCase,
  duplicateWritingSelection,
  insertWritingIndent,
  toggleWritingStyle,
} from "./latexEditingCommands";

interface WritingShortcutOptions {
  readonly onCompile: () => void;
  readonly onOpenCommands: () => void;
}

/** Overleaf-style source editing, using public CodeMirror commands. */
export function writingKeymap(options: WritingShortcutOptions): Extension {
  const compile: KeyBinding["run"] = () => { options.onCompile(); return true; };
  return [
    EditorView.contentAttributes.of({"data-tab-action": "both"}),
    ViewPlugin.define((view) => {
      // Ignore IME candidate keys even before its first document change. Let the
      // native input method handle the event without cancelling its default.
      const ignoreCompositionKey = (event: KeyboardEvent): void => {
        if (event.isComposing || event.keyCode === 229) event.stopImmediatePropagation();
      };
      view.contentDOM.addEventListener("keydown", ignoreCompositionKey, true);
      return { destroy: () => view.contentDOM.removeEventListener("keydown", ignoreCompositionKey, true) };
    }),
    Prec.high(keymap.of([
      { key: "Tab", run: acceptCompletion },
      { key: "Tab", run: insertWritingIndent, shift: indentLess, preventDefault: true },
      { key: "Alt-Space", run: startCompletion },
      { key: "Mod-s", preventDefault: true, run: compile },
      { key: "Mod-Enter", preventDefault: true, run: compile },
      { key: "Ctrl-.", preventDefault: true, run: compile },
      { key: "Mod-d", preventDefault: true, run: deleteLine },
      { key: "Mod-Shift-d", preventDefault: true, run: duplicateWritingSelection },
      { key: "Mod-Shift-l", preventDefault: true, run: gotoLine },
      { key: "Mod-b", preventDefault: true, run: toggleWritingStyle("textbf") },
      { key: "Mod-i", preventDefault: true, run: toggleWritingStyle("textit") },
      // Overleaf's source and detailed shortcut reference use Control on macOS too.
      { key: "Ctrl-u", preventDefault: true, run: changeWritingCase("upper") },
      { key: "Ctrl-Shift-u", preventDefault: true, run: changeWritingCase("lower") },
      { key: "Mod-y", preventDefault: true, run: redo },
      { key: "Mod-Shift-z", preventDefault: true, run: redo },
      { key: "F2", preventDefault: true, run: toggleFold },
      { key: "Alt-Shift-1", preventDefault: true, run: foldAll },
      { key: "Alt-Shift-0", preventDefault: true, run: unfoldAll },
      { key: "Mod-Shift-p", preventDefault: true, run: () => { options.onOpenCommands(); return true; } },
    ])),
  ];
}
