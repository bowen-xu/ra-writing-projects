// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { cursorCharRight, deleteCharBackward, undo } from "@codemirror/commands";
import { createLatexEditorState } from "../editorState";
import { refreshCitationReferences } from "./citationReferences";
import type { WritingCitationLabel } from "../../citations/citationLabels";

const label: WritingCitationLabel = {citationKey: "Xu2026", author: "Xu 等", issuedYear: 2026,
  title: "Vision by Logic: a long synthetic title for truncation"};
const views: EditorView[] = [];
afterEach(async () => {await act(async () => {for (const view of views.splice(0)) view.destroy();}); document.body.replaceChildren();});

async function editor(content = "\\cite{Xu2026}", initial: readonly WritingCitationLabel[] = [label]) {
  let labels = initial;
  let view!: EditorView;
  await act(async () => {view = new EditorView({parent: document.body, state: createLatexEditorState({content,
    onChange: vi.fn(), onCompile: vi.fn(), onOpenCommands: vi.fn(), onCursorChange: vi.fn(), codeCheckEnabled: false,
    getCompletionData: () => ({citationKeys: labels.map(row => row.citationKey), citationReferences: labels, files: [], labels: []}),
  })});});
  views.push(view);
  return {view, refresh: async (next: readonly WritingCitationLabel[]) => {labels = next; await act(async () => view.dispatch({effects: refreshCitationReferences.of(null)}));}};
}

it("uses the shared reference component without an icon and retains exact source bytes", async () => {
  const source = "before \\citep*[see][p. 2]{Xu2026, Xu2026} after";
  const {view} = await editor(source);
  const tags = view.dom.querySelectorAll(".inline-reference.writing-citation-reference");
  expect(tags).toHaveLength(2);
  expect(tags[0]?.textContent).toBe("(Xu 等, 2026)Vision…");
  expect(tags[0]?.getAttribute("aria-label")).toBe(`(Xu 等, 2026) ${label.title}`);
  expect(tags[0]?.getAttribute("title")).toContain(label.title);
  expect(tags[0]?.querySelector("svg")).toBeNull();
  expect(tags[0]?.querySelector(".writing-citation-title")).not.toBeNull();
  expect(view.state.doc.toString()).toBe(source);
});

it("skips across a key, selects it as a whole and supports atomic deletion and undo", async () => {
  const {view} = await editor();
  const from = "\\cite{".length, to = from + label.citationKey.length;
  await act(async () => {view.dispatch({selection: {anchor: from}}); cursorCharRight(view);});
  expect(view.state.selection.main.head).toBe(to);
  await act(async () => {deleteCharBackward(view);});
  expect(view.state.doc.toString()).toBe("\\cite{}");
  await act(async () => {undo(view);});
  expect(view.state.doc.toString()).toBe("\\cite{Xu2026}");
  const tag = view.dom.querySelector<HTMLElement>(".writing-citation-reference");
  await act(async () => tag?.click());
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(label.citationKey);
});

it.each([
  ["\\cite{Xu2026", 1],
  ["\\cite{Xu2026\n\n\\section{Next}", 1],
  ["\\citep*[see]{Xu2026, Xu2026", 2],
  ["\\cite{Xu2026,\nXu2026}", 2],
  ["\\cite{Xu2026, partial", 1],
  ["\\cite{partialXu2026", 0],
  ["\\cite{Xu2026more", 0],
])("retains complete managed keys independently of closing braces: %s", async (source, count) => {
  const {view} = await editor(source);
  expect(view.dom.querySelectorAll(".writing-citation-reference")).toHaveLength(count);
  expect(view.state.doc.toString()).toBe(source);
});

it("retains a tag when deleting its closing brace and supports whole-key deletion and undo", async () => {
  const {view} = await editor();
  await act(async () => {view.dispatch({selection: {anchor: view.state.doc.length}}); deleteCharBackward(view);});
  expect(view.state.doc.toString()).toBe("\\cite{Xu2026");
  expect(view.dom.querySelector(".writing-citation-title")?.textContent).toBe("Vision…");
  await act(async () => view.dom.querySelector<HTMLElement>(".writing-citation-reference")?.click());
  await act(async () => {deleteCharBackward(view);});
  expect(view.state.doc.toString()).toBe("\\cite{");
  await act(async () => {undo(view);});
  expect(view.state.doc.toString()).toBe("\\cite{Xu2026");
  expect(view.dom.querySelectorAll(".writing-citation-reference")).toHaveLength(1);
});

it("expands partial user edits but preserves exact Agent replacement ranges", async () => {
  const {view} = await editor();
  await act(async () => view.dispatch({changes: {from: 8, to: 10}, userEvent: "delete.cut"}));
  expect(view.state.doc.toString()).toBe("\\cite{}");
  await act(async () => {undo(view); view.dispatch({changes: {from: 8, to: 10, insert: "x"}, userEvent: "input.agent"});});
  expect(view.state.doc.toString()).toBe("\\cite{Xux26}");
});

it("refreshes labels without editing the source or replacing the editor history", async () => {
  const {view, refresh} = await editor("\\cite{Xu2026}", []);
  expect(view.dom.querySelector(".writing-citation-reference")).toBeNull();
  await act(async () => view.dispatch({changes: {from: 0, insert: "a "}, userEvent: "input.type"}));
  await refresh([label]);
  expect(view.dom.querySelector(".writing-citation-title")?.textContent).toBe("Vision…");
  await refresh([{...label, title: "Updated title"}]);
  expect(view.dom.querySelector(".writing-citation-title")?.textContent).toBe("Updated…");
  await act(async () => view.dom.querySelector<HTMLElement>(".writing-citation-reference")?.click());
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(label.citationKey);
  await act(async () => {undo(view);});
  expect(view.state.doc.toString()).toBe("\\cite{Xu2026}");
});

it("leaves unresolved keys, comments and literal examples as editable source", async () => {
  const {view} = await editor("% \\cite{Xu2026}\n\\verb|\\cite{Xu2026}|\n\\begin{verbatim}\n\\cite{Xu2026}\n\\end{verbatim}\n\\cite{missing}");
  expect(view.dom.querySelectorAll(".writing-citation-reference")).toHaveLength(0);
});

it.each([
  ["Vision by Logic", "Vision…"],
  ["  Vision\tby Logic  ", "Vision…"],
  ["Vision", "Vision"],
  ["  Vision  ", "Vision"],
  ["视觉 逻辑", "视觉…"],
])("marks omitted title words without changing the full hint: %s", async (title, visible) => {
  const {view} = await editor("\\cite{Xu2026}", [{...label, title}]);
  const tag = view.dom.querySelector(".writing-citation-reference");
  expect(tag?.querySelector(".writing-citation-title")?.textContent).toBe(visible);
  expect(tag?.getAttribute("title")).toContain(title);
  expect(view.state.doc.toString()).toBe("\\cite{Xu2026}");
});
