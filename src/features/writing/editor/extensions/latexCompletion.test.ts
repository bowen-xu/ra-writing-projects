// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { acceptCompletion, completionStatus, currentCompletions, setSelectedCompletion, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createLatexEditorState } from "../editorState";

const views: EditorView[] = [];
afterEach(() => {for (const view of views.splice(0)) view.destroy(); document.body.replaceChildren();});

function editor(content: string, position = content.length) {
  const view = new EditorView({parent: document.body, state: createLatexEditorState({content,
    onChange: vi.fn(), onCompile: vi.fn(), onOpenCommands: vi.fn(), onCursorChange: vi.fn(), codeCheckEnabled: false,
    getCompletionData: () => ({citationKeys: [], files: [], labels: []}),
  })});
  views.push(view);
  view.dispatch({selection: {anchor: position}});
  return view;
}

async function choose(view: EditorView, command: string) {
  startCompletion(view);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  const index = currentCompletions(view.state).findIndex(option => option.label === command);
  expect(index).toBeGreaterThanOrEqual(0);
  view.dispatch({effects: setSelectedCompletion(index)});
  expect(acceptCompletion(view)).toBe(true);
}

it("uses the shared SVG completion presentation in the writing editor", async () => {
  const view = editor("\\a"); startCompletion(view);
  await vi.waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete .editor-completion-icon svg")).not.toBeNull());
  expect(document.querySelector(".cm-tooltip-autocomplete .cm-completionIcon-keyword")).toBeNull();
});

it.each(["cite", "section", "begin", "end", "ref", "input", "includegraphics", "textbf", "usepackage"])(
  "completes %s with braces and places the cursor inside, in one undo step", async command => {
    const source = `\\${command.slice(0, 2)}`, view = editor(source);
    await choose(view, command);
    expect(view.state.doc.toString()).toBe(`\\${command}{}`);
    expect(view.state.selection.main.head).toBe(`\\${command}{`.length);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

it.each(["{Existing}", "{}", "[see]{Existing}"])("preserves existing arguments: %s", async argument => {
  const view = editor(`\\cit${argument}`, 4);
  await choose(view, "cite");
  expect(view.state.doc.toString()).toBe(`\\cite${argument}`);
  expect(view.state.selection.main.head).toBe(6);
});

it("does not add a required argument to item", async () => {
  const view = editor("\\ite");
  await choose(view, "item");
  expect(view.state.doc.toString()).toBe("\\item");
  expect(view.state.selection.main.head).toBe(5);
});

it("preserves per-cursor arguments and leaves unrelated selections unchanged", async () => {
  const view = editor("\\cit\n\\cit{Existing}\nword", 4);
  view.dispatch({selection: EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(9), EditorSelection.cursor(24)])});
  await choose(view, "cite");
  expect(view.state.doc.toString()).toBe("\\cite{}\n\\cite{Existing}\nword");
  expect(view.state.selection.ranges.map(range => range.head)).toEqual([6, 14, 28]);
});
