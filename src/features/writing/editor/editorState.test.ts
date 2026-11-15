// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EditorView as View } from "@codemirror/view";

let createState: typeof import("./editorState").createLatexEditorState;
let EditorView: typeof import("@codemirror/view").EditorView;
let autocomplete: typeof import("@codemirror/autocomplete");
let selection: typeof import("@codemirror/state").EditorSelection;
const views: View[] = [];

beforeAll(async () => {
  // Exercise actual macOS key resolution, including Control-only case commands.
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  ({ createLatexEditorState: createState } = await import("./editorState"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ EditorSelection: selection } = await import("@codemirror/state"));
  autocomplete = await import("@codemirror/autocomplete");
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function editor(content: string, from = 0, to = from) {
  const onCompile = vi.fn();
  const onChange = vi.fn();
  const view = new EditorView({
    parent: document.body,
    state: createState({
      content, onCompile, onChange, onOpenCommands: vi.fn(), onCursorChange: vi.fn(),
      getCompletionData: () => ({ citationKeys: ["Smith2024"], files: [], labels: [] }),
    }),
  });
  views.push(view);
  view.dispatch({ selection: { anchor: from, head: to } });
  return { view, onCompile, onChange };
}

function press(view: View, key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Tab: 9, Enter: 13 }[key] ?? 0),
    bubbles: true, cancelable: true, ...modifiers,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("Overleaf-style writing keys", () => {
  it("accepts a visible completion with Tab without inserting indentation", async () => {
    const { view } = editor("\\sec", 4);
    autocomplete.startCompletion(view);
    await vi.waitFor(() => expect(autocomplete.completionStatus(view.state)).toBe("active"));
    press(view, "Tab");
    expect(view.state.doc.toString()).toBe("\\section{}");
    expect(view.state.selection.main.head).toBe("\\section{".length);
  });

  it("accepts with Enter, while ordinary Enter inserts a newline and never compiles", async () => {
    const { view, onCompile } = editor("\\sec", 4);
    autocomplete.startCompletion(view);
    await vi.waitFor(() => expect(autocomplete.completionStatus(view.state)).toBe("active"));
    press(view, "Enter");
    expect(view.state.doc.toString()).toBe("\\section{}");
    press(view, "Enter");
    expect(view.state.doc.toString()).toBe("\\section{\n\n}");
    expect(onCompile).not.toHaveBeenCalled();
  });

  it("inserts spaces at an empty cursor and indents selected lines", () => {
    const { view } = editor("abc", 1);
    press(view, "Tab");
    expect(view.state.doc.toString()).toBe("a  bc");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    press(view, "Tab");
    expect(view.state.doc.toString()).toBe("  a  bc");
    press(view, "Tab", { shiftKey: true });
    expect(view.state.doc.toString()).toBe("a  bc");
  });

  it("uses Cmd+D for deletion and both Overleaf redo bindings", () => {
    const { view } = editor("first\nsecond", 2);
    press(view, "d", { metaKey: true });
    expect(view.state.doc.toString()).toBe("second");
    press(view, "z", { metaKey: true });
    expect(view.state.doc.toString()).toBe("first\nsecond");
    press(view, "y", { metaKey: true });
    expect(view.state.doc.toString()).toBe("second");
    press(view, "z", { metaKey: true });
    press(view, "Z", { metaKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("second");
  });

  it("opens go-to-line with Cmd+Shift+L instead of selecting matches", () => {
    const { view } = editor("alpha\nalpha");
    press(view, "L", { metaKey: true, shiftKey: true });
    expect(document.querySelector('.cm-dialog input[name="line"]')).not.toBeNull();
  });

  it.each(["b", "i"])("toggles LaTeX style with Cmd+%s and keeps the content selected", (key) => {
    const { view } = editor("word", 0, 4);
    press(view, key, { metaKey: true });
    expect(view.state.doc.toString()).toBe(`\\${key === "b" ? "textbf" : "textit"}{word}`);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("word");
    press(view, key, { metaKey: true });
    expect(view.state.doc.toString()).toBe("word");
  });

  it("places an empty cursor inside the formatting braces", () => {
    const { view } = editor("");
    press(view, "b", { metaKey: true });
    expect(view.state.doc.toString()).toBe("\\textbf{}");
    expect(view.state.selection.main.head).toBe(8);
  });

  it("does not mistake an inner closing brace for the style wrapper", () => {
    const { view } = editor("\\textbf{a{b}c}", 8, 11);
    press(view, "b", { metaKey: true });
    expect(view.state.doc.toString()).toBe("\\textbf{\\textbf{a{b}}c}");
  });

  it("unwraps balanced nested groups and ignores escaped braces and comments", () => {
    const content = "a{b} \\{ % }\n c";
    const { view } = editor(`\\textbf{${content}}`, 8, 8 + content.length);
    press(view, "b", { metaKey: true });
    expect(view.state.doc.toString()).toBe(content);
  });

  it("uses Control for case changes on Mac and retains Unicode selections", () => {
    const { view } = editor("straße 中文", 0, 9);
    press(view, "u", { ctrlKey: true });
    expect(view.state.doc.toString()).toBe("STRASSE 中文");
    expect(view.state.selection.main.to).toBe(10);
    press(view, "U", { ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("strasse 中文");
  });

  it("duplicates a selected fragment, or the current line when nothing is selected", () => {
    const { view } = editor("abc def", 0, 3);
    press(view, "D", { metaKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("abcabc def");
    view.dispatch({ selection: { anchor: 0 } });
    press(view, "D", { metaKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("abcabc def\nabcabc def");
  });

  it("preserves multiple selections through formatting and undo", () => {
    const { view } = editor("one two");
    view.dispatch({ selection: selection.create([selection.range(0, 3), selection.range(4, 7)]) });
    expect(view.state.selection.ranges).toHaveLength(2);
    press(view, "b", { metaKey: true });
    expect(view.state.doc.toString()).toBe("\\textbf{one} \\textbf{two}");
    expect(view.state.selection.ranges).toHaveLength(2);
    press(view, "z", { metaKey: true });
    expect(view.state.doc.toString()).toBe("one two");
  });

  it("routes Cmd+S, Cmd+Enter and Control+period to the same compile action", () => {
    const { view, onCompile } = editor("text");
    press(view, "s", { metaKey: true });
    press(view, "Enter", { metaKey: true });
    press(view, ".", { ctrlKey: true });
    expect(onCompile).toHaveBeenCalledTimes(3);
    expect(view.state.doc.toString()).toBe("text");
  });

  it("does not run editing shortcuts during IME composition", () => {
    const { view } = editor("中文\nkeep");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const event = press(view, "d", { metaKey: true, isComposing: true, keyCode: 229 });
    expect(view.state.doc.toString()).toBe("中文\nkeep");
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("writing search and display preferences", () => {
  it("filters whole words and case, replaces matches, and supports undo", async () => {
    const { openSearchPanel } = await import("@codemirror/search");
    const { view } = editor("cat Cat scatter cat");
    openSearchPanel(view);
    const search = document.querySelector<HTMLInputElement>('input[aria-label="查找内容"]');
    const replacement = document.querySelector<HTMLInputElement>('input[aria-label="替换为"]');
    if (!search || !replacement) throw new Error("Missing search inputs");
    search.value = "cat";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".editor-search-status")?.textContent).toMatch(/\/ 4$/);
    document.querySelector<HTMLButtonElement>('button[aria-label="全词匹配"]')?.click();
    document.querySelector<HTMLButtonElement>('button[aria-label="区分大小写"]')?.click();
    expect(document.querySelector(".editor-search-status")?.textContent).toMatch(/\/ 2$/);
    expect(replacement.closest<HTMLDivElement>(".editor-replace-row")?.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('.text-search-panel button[aria-expanded="false"]')?.click();
    expect(replacement.closest<HTMLDivElement>(".editor-replace-row")?.hidden).toBe(false);
    replacement.value = "dog";
    replacement.dispatchEvent(new Event("input", { bubbles: true }));
    [...document.querySelectorAll<HTMLButtonElement>(".text-search-panel button")].find((button) => button.getAttribute("aria-label") === "全部替换")?.click();
    expect(view.state.doc.toString()).toBe("dog Cat scatter dog");
    press(view, "z", { metaKey: true });
    expect(view.state.doc.toString()).toBe("cat Cat scatter cat");
    search.value = "[";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('button[aria-label="正则表达式"]')?.click();
    expect(search.getAttribute("aria-invalid")).toBe("true");
    expect([...document.querySelectorAll<HTMLButtonElement>(".text-search-panel button")].find((button) => button.getAttribute("aria-label") === "全部替换")?.disabled).toBe(true);
  });

  it("changes display preferences without losing the selection or undo history", async () => {
    const { editorPreferencesCompartment, editorPreferenceExtensions, readEditorPreferences } = await import("./editorPreferences");
    const { view } = editor("word", 0, 4);
    press(view, "b", { metaKey: true });
    view.dispatch({ effects: editorPreferencesCompartment.reconfigure(editorPreferenceExtensions(readEditorPreferences({ fontSize: 20, tabSize: 4, showLineNumbers: false, lineWrapping: false }))) });
    expect(document.querySelector(".cm-lineNumbers")).toBeNull();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("word");
    press(view, "z", { metaKey: true });
    expect(view.state.doc.toString()).toBe("word");
    view.dispatch({ selection: { anchor: 4 } });
    press(view, "Tab");
    expect(view.state.doc.toString()).toBe("word    ");
  });
});

it("opens all BibTeX paths as selectable read-only documents and rejects Agent edits",async()=>{
 const {createWritingStateSessionPort}=await import("./editorSessionPort");
 const state=createState({content:"@book{key,title={Synthetic}}",filePath:"sources/LOCAL.BIB",onChange:vi.fn(),onCursorChange:vi.fn(),onCompile:vi.fn(),onOpenCommands:vi.fn(),getCompletionData:()=>({citationKeys:[],files:[],labels:[]})});
 expect(state.readOnly).toBe(true);expect(state.facet(EditorView.editable)).toBe(false);
 const view=new EditorView({parent:document.body,state});views.push(view);
 expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
 const port=createWritingStateSessionPort({documentKey:"m:sources/LOCAL.BIB",readState:()=>view.state,isComposing:()=>false,dispatch:transaction=>view.dispatch(transaction)});
 const snapshot=port.read();if(!snapshot)throw new Error("Missing snapshot");expect(snapshot.text).toContain("Synthetic");
 expect(port.apply({operationId:"attempt",expected:snapshot,text:"changed"})).toEqual({status:"unavailable"});expect(view.state.doc.toString()).toBe(snapshot.text);
});

it("reloads managed bibliography projections without publishing them as user edits or save requests",()=>{
 const onChange=vi.fn(),onDocumentChange=vi.fn();
 const view=new EditorView({parent:document.body,state:createState({content:"@book{key,title={Old}}",filePath:"references.bib",
 onChange,onDocumentChange,onCursorChange:vi.fn(),onCompile:vi.fn(),onOpenCommands:vi.fn(),getCompletionData:()=>({citationKeys:[],files:[],labels:[]})})});views.push(view);
 view.dispatch({changes:{from:0,to:view.state.doc.length,insert:"@book{key,title={New}}"},userEvent:"input.agent"});
 expect(view.state.doc.toString()).toContain("New");expect(view.state.readOnly).toBe(true);
 expect(onChange).not.toHaveBeenCalled();expect(onDocumentChange).not.toHaveBeenCalled();
});
