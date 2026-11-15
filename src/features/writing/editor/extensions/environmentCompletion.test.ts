// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { acceptCompletion, completionStatus, currentCompletions, hasNextSnippetField, nextSnippetField, prevSnippetField, setSelectedCompletion, startCompletion } from "@codemirror/autocomplete";
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createLatexEditorState } from "../editorState";

const views: EditorView[] = [];
afterEach(() => {for (const view of views.splice(0)) view.destroy(); document.body.replaceChildren();});
function editor(source: string, cursor = source.length) {
  const view = new EditorView({parent: document.body, state: createLatexEditorState({content: source,
    getCompletionData: () => ({citationKeys: [], files: [], labels: []}), codeCheckEnabled: false,
    onChange: vi.fn(), onCompile: vi.fn(), onOpenCommands: vi.fn(), onCursorChange: vi.fn(),
  })});
  views.push(view); view.dispatch({selection: {anchor: cursor}}); return view;
}
async function complete(view: EditorView, label: string) {
  startCompletion(view);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  const index = currentCompletions(view.state).findIndex(option => option.label === label);
  expect(index).toBeGreaterThanOrEqual(0);
  view.dispatch({effects: setSelectedCompletion(index)}); expect(acceptCompletion(view)).toBe(true);
}
const environmentList = ["abstract", "align", "align*", "array", "center", "description", "document", "equation", "equation*", "enumerate", "figure", "frame", "gather", "gather*", "itemize", "multline", "multline*", "quote", "split", "table", "tabular", "verbatim", "figure*", "table*", "theorem", "proof"];

it.each(environmentList)("inserts a complete %s environment as one undoable edit", async name => {
  const view = editor("\\begin{}", 7);
  await complete(view, `\\begin{${name}} …`);
  const result = view.state.doc.toString();
  expect(result).toContain(`\\begin{${name}}`); expect(result).toContain(`\n\\end{${name}}`);
  expect(result).not.toContain("${"); expect(result).not.toMatch(/\}\}$/u);
  expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("\\begin{}");
  expect(redo(view)).toBe(true); expect(view.state.doc.toString()).toBe(result);
});

it.each([["\\begin{itemi", 11], ["\\begin{itemize}", 14], ["\\begin{itemize}", 10]] as const)("completes lists from partial or closed headers: %s", async (source, cursor) => {
  const view = editor(source, cursor);
  await complete(view, "\\begin{itemize} …");
  expect(view.state.doc.toString()).toBe("\\begin{itemize}\n  \\item \n\\end{itemize}");
  expect(view.state.selection.main.head).toBe("\\begin{itemize}\n  \\item ".length);
  expect(hasNextSnippetField(view.state)).toBe(false);
});

it("offers the environment after its closing brace, and from a direct command prefix", async () => {
  const view = editor("\\begin{itemize}");
  await complete(view, "\\begin{itemize} …");
  const command = editor("\\enume");
  await complete(command, "begin{enumerate} …");
  expect(command.state.doc.toString()).toBe("\\begin{enumerate}\n  \\item \n\\end{enumerate}");
});

it("retains indentation and leaves document contents unindented", async () => {
  const view = editor("    \\begin{ali");
  await complete(view, "\\begin{align} …");
  expect(view.state.doc.toString()).toBe("    \\begin{align}\n      \n    \\end{align}");
  const document = editor("\\begin{doc");
  await complete(document, "\\begin{document} …");
  expect(document.state.doc.toString()).toBe("\\begin{document}\n\n\\end{document}");
});

it("navigates figure fields forward/backward and exits after the closing environment", async () => {
  const view = editor("\\begin{fig");
  await complete(view, "\\begin{figure} …");
  view.dispatch(view.state.replaceSelection("plot.pdf"));
  expect(nextSnippetField(view)).toBe(true);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("Caption");
  expect(prevSnippetField(view)).toBe(true);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("plot.pdf");
  nextSnippetField(view); nextSnippetField(view);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("fig:placeholder");
  nextSnippetField(view);
  expect(view.state.selection.main.head).toBe(view.state.doc.length);
});

it("Escape clears snippet fields even when a completion request is still pending", async () => {
  const view = editor("\\begin{fig");
  await complete(view, "\\begin{figure} …");
  startCompletion(view);
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", keyCode: 27, bubbles: true, cancelable: true}));
  expect(hasNextSnippetField(view.state)).toBe(false);
});

it("supplies table, array, frame and description fields", async () => {
  for (const [name, expected] of [["table", "\\begin{tabular}{c|c}"], ["array", "\\begin{array}{cc}"], ["frame", "\\begin{frame}{Frame Title}"], ["description", "\\item[] "]] as const) {
    const view = editor(`\\begin{${name}`);
    await complete(view, `\\begin{${name}} …`);
    expect(view.state.doc.toString()).toContain(expected);
    expect(hasNextSnippetField(view.state)).toBe(true);
  }
});

it("preserves user-written environment arguments and an existing body/end", async () => {
  const view = editor("\\begin{tabular}{lcr}", 10);
  await complete(view, "\\begin{tabular} …");
  expect(view.state.doc.toString()).toContain("\\begin{tabular}{lcr}\n");
  expect(view.state.doc.toString()).not.toContain("c|c");
  const body = "\\begin{itemi}\n  \\item Existing\n\\end{itemize}";
  const existing = editor(body, "\\begin{itemi".length);
  await complete(existing, "\\begin{itemize} …");
  expect(existing.state.doc.toString()).toBe(body.replace("{itemi}", "{itemize}"));
});

it("does not consume an enclosing command's closing brace", async () => {
  const view = editor("\\emph{\\begin{itemi}}", "\\emph{\\begin{itemi".length);
  await complete(view, "\\begin{itemize} …");
  expect(view.state.doc.toString()).toBe("\\emph{\\begin{itemize}\n  \\item \n\\end{itemize}}");
});

it("discovers declared/previous custom environments and offers a typed new name", async () => {
  const source = "\\newenvironment{custom-box}{}{}\n\\begin{past}\n\\end{past}\n\\begin{cus";
  const view = editor(source);
  await complete(view, "\\begin{custom-box} …");
  expect(view.state.doc.toString()).toContain("\\begin{custom-box}\n  \n\\end{custom-box}");
  const fresh = editor("\\begin{brandnew}");
  await complete(fresh, "\\begin{brandnew} …");
  expect(fresh.state.doc.toString()).toBe("\\begin{brandnew}\n  \n\\end{brandnew}");
});

it("preserves nested required/optional arguments without treating their text as snippet fields", async () => {
  const view = editor("\\begin{custom-box}[h]{{left [text]} \\{x\\} #{literal}}", 12);
  await complete(view, "\\begin{custom-box} …");
  expect(view.state.doc.toString()).toContain("\\begin{custom-box}[h]{{left [text]} \\{x\\} #{literal}}\n");
});

it("can complete a literal environment's own end while excluding its example code", async () => {
  const view = editor("\\begin{verbatim}\n\\begin{fake}\n\\end{ver");
  await complete(view, "verbatim");
  expect(view.state.doc.toString()).toMatch(/\\end\{verbatim\}$/u);
});

it("ranks innermost unclosed ends first, handles repeated names, and closes the brace", async () => {
  const view = editor("\\begin{document}\n\\begin{enumerate}\n\\begin{enumerate}\n\\end{enumerate}\n\\end{}");
  view.dispatch({selection: {anchor: view.state.doc.length - 1}});
  startCompletion(view);
  await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toEqual(["enumerate", "document"]));
  expect(acceptCompletion(view)).toBe(true);
  expect(view.state.doc.toString()).toMatch(/\\end\{enumerate\}$/u);
});

it.each(["% \\begin{itemi", "\\verb|\\begin{itemi", "\\begin{verbatim}\n\\begin{itemi"])("does not offer executable environments in literal content: %s", async source => {
  const view = editor(source);
  startCompletion(view);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull());
});
