/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { afterEach, expect, it, vi } from "vitest";
import { LatexEditor } from "./LatexEditor";
import { createWritingEditorSessionPort } from "./editorSessionPort";
import { Text } from "@codemirror/state";
import { WritingFileSessions } from "./writingFileSessions";
import { parseManuscriptPath } from "@research-assistant/writing";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

async function render(props: Partial<ComponentProps<typeof LatexEditor>> = {}): Promise<EditorView> {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(<LatexEditor documentKey="manuscript:main.tex" value="old"
    onChange={vi.fn()} onCompile={vi.fn()} onOpenCommands={vi.fn()} diagnostics={[]}
    focusRequest={undefined} onCursorChange={vi.fn()}
    completionData={{ citationKeys: [], files: [], labels: [] }} codeCheckEnabled={false}
    onCodeCheckResult={vi.fn()} {...props} />));
  const element = host.querySelector(".cm-editor");
  const view = element instanceof HTMLElement ? EditorView.findFromDOM(element) : null;
  if (!view) throw new Error("Missing production editor");
  return view;
}

it("selects an inclusive source range across Unicode rows and refuses stale locations", async () => {
  // Browsers deliver selectionchange asynchronously. happy-dom dispatches it
  // during CodeMirror's own selection update and otherwise re-enters that update.
  const preventSynchronousSelection = (event: Event) => event.stopImmediatePropagation();
  document.addEventListener("selectionchange", preventSynchronousSelection, true);
  try {
  const located = vi.fn(), failed = vi.fn();
  const value = "A😀BC\nsecond";
  const view = await render({value, focusRequest: {line: 1, token: 501, range: {startLine: 1, startColumn: 2, endLine: 2, endColumn: 3}, onLocated: located, onError: failed}});
  expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe("😀BC\nsec");
  expect(failed).not.toHaveBeenCalled();
  expect(located).toHaveBeenCalledOnce();
  await render({value, focusRequest: {line: 9, token: 502, range: {startLine: 9, startColumn: 1, endLine: 9, endColumn: 2}, onLocated: located, onError: failed}});
  expect(failed).toHaveBeenCalledOnce();
  expect(located).toHaveBeenCalledOnce();
  expect(view.state.doc.toString()).toBe(value);
  } finally { document.removeEventListener("selectionchange", preventSynchronousSelection, true); }
});

it("publishes an Agent editor transaction to the host's saving buffer", async () => {
  const onChange = vi.fn();
  const view = await render({ onChange });
  const port = createWritingEditorSessionPort(view, "manuscript:main.tex");
  const expected = port.read();
  if (!expected) throw new Error("Missing editor snapshot");
  await act(async () => expect(port.apply({ operationId: "agent-operation", expected, text: "agent" }).status).toBe("applied"));
  expect(view.state.doc.toString()).toBe("agent");
  expect(onChange).toHaveBeenLastCalledWith("agent");
  port.dispose();
});

it("initializes a restored checkpoint with its saved cursor and does not replay the restored document as an edit", async () => {
  const files = new WritingFileSessions();
  const restored = files.restore({ schemaVersion: 1, manuscriptId: "manuscript", relativePath: parseManuscriptPath("main.tex"),
    content: "confirmed text", reviewBaseline: "confirmed text", version: 4, savedVersion: 2, savedSha256: "a".repeat(64),
    operations: [], saveIntent: null });
  const view = await render({ fileSession: restored, value: "confirmed text", initialCursor: 8 });
  expect(view.state.selection.main.head).toBe(8);
  expect(view.state.doc.toString()).toBe("confirmed text");
  expect(getOriginalDoc(view.state).toString()).toBe("confirmed text");
  expect(restored.read().version).toBe(4);
  expect(undo(view)).toBe(false);
});

it("uses one view while retaining each file's cursor, baseline and undo history", async () => {
  const sessions = new WritingFileSessions();
  const first = sessions.open({ manuscriptId: "manuscript", relativePath: "main.tex" }, "old first");
  first.applyAgent("first-agent", 0, "new first");
  const second = sessions.open({ manuscriptId: "manuscript", relativePath: "second.tex" }, "old second");
  const firstChange = vi.fn();
  const secondChange = vi.fn();
  const view = await render({ fileSession: first, value: "new first", onChange: firstChange });
  await act(async () => view.dispatch({ selection: { anchor: 4 } }));
  await act(async () => (host?.querySelector('[aria-label="Keep all"]') as HTMLButtonElement).click());
  expect(await render({ documentKey: "manuscript:second.tex", fileSession: second, value: "old second", onChange: secondChange }) === view).toBe(true);
  await act(async () => view.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type", selection: { anchor: 7 } }));
  expect(await render({ fileSession: first, value: "new first", onChange: firstChange }) === view).toBe(true);
  expect(view.state.selection.main.head).toBe(4);
  expect(view.state.doc.toString()).toBe("new first");
  await act(async () => expect(undo(view)).toBe(true));
  expect(getOriginalDoc(view.state).toString()).toBe("old first");
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  secondChange.mockClear();
  await act(async () => expect(undo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe("old first");
  expect(secondChange).not.toHaveBeenCalled();
  expect(await render({ documentKey: "manuscript:second.tex", fileSession: second, value: "manual old second", onChange: secondChange }) === view).toBe(true);
  expect(view.state.selection.main.head).toBe(7);
  expect(view.state.doc.toString()).toBe("manual old second");
  await act(async () => expect(undo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe("old second");
});

it("retains selection when reopening a file that has not been edited", async () => {
  const sessions = new WritingFileSessions();
  const first = sessions.open({ manuscriptId: "manuscript", relativePath: "main.tex" }, "first file");
  const second = sessions.open({ manuscriptId: "manuscript", relativePath: "second.tex" }, "second file");
  const view = await render({ fileSession: first, value: "first file", initialCursor: 0 });
  await act(async () => view.dispatch({ selection: { anchor: 6 } }));
  await render({ documentKey: "manuscript:second.tex", fileSession: second, value: "second file", initialCursor: 0 });
  await render({ fileSession: first, value: "first file", initialCursor: 0 });
  expect(view.state.selection.main.head).toBe(6);
  expect(first.read().version).toBe(0);
});

it("does not replay a citation insertion or an old focus request when switching files", async () => {
  const sessions = new WritingFileSessions();
  const first = sessions.open({ manuscriptId: "manuscript", relativePath: "main.tex" }, "first\nsecond line");
  const second = sessions.open({ manuscriptId: "manuscript", relativePath: "second.tex" }, "other\nline");
  const insertionRequest = { text: "citation", token: 1 };
  const focusRequest = { line: 2, token: 1 };
  const view = await render({ fileSession: first, value: "first\nsecond line", focusRequest, insertionRequest });
  const inserted = view.state.doc.toString();
  await act(async () => view.dispatch({ selection: { anchor: 2 } }));
  await render({ documentKey: "manuscript:second.tex", fileSession: second, value: "other\nline", insertionRequest, focusRequest: undefined });
  expect(view.state.doc.toString()).toBe("other\nline");
  await render({ fileSession: first, value: inserted, focusRequest, insertionRequest });
  expect(view.state.doc.toString()).toBe(inserted);
  expect(view.state.selection.main.head).toBe(2);
});

it("retains the view and history through plain, pending and confirmed states", async () => {
  const view = await render();
  await act(async () => view.dispatch({ selection: { anchor: 1 } }));
  const controls = { onResolveChange: vi.fn() };
  expect(await render({ diff: { before: "old", after: "agent", controls } }) === view).toBe(true);
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => (host?.querySelector('[aria-label="Keep all"]') as HTMLButtonElement).click());
  expect(getOriginalDoc(view.state).toString()).toBe("agent");
  expect(await render({ value: "agent" }) === view).toBe(true);
  await act(async () => expect(undo(view)).toBe(true));
  expect(getOriginalDoc(view.state).toString()).toBe("old");
  expect(view.state.doc.toString()).toBe("agent");
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  expect(host?.querySelector('[aria-label="Keep all"]')).not.toBeNull();
});

it.each(["Keep all", "Undo all"])("resolves multiple chunks with one %s history transaction", async (label) => {
  const middle = "\nunchanged one\nunchanged two\nunchanged three\n";
  const before = `first old${middle}last old`;
  const after = `first new${middle}last new`;
  const view = await render({ value: before, diff: { before, after, controls: { onResolveChange: vi.fn() } } });
  expect(getChunks(view.state)?.chunks).toHaveLength(2);
  await act(async () => (host?.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click());
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
  await act(async () => expect(undo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
  expect(getChunks(view.state)?.chunks).toHaveLength(2);
  await act(async () => expect(redo(view)).toBe(true));
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
});

it("publishes baseline-only Keep and its history inverse as complete document snapshots", async () => {
  const onDocumentChange = vi.fn();
  const view = await render({ onDocumentChange, diff: { before: "old", after: "agent" } });
  onDocumentChange.mockClear();
  await act(async () => (host?.querySelector('[aria-label="Keep all"]') as HTMLButtonElement).click());
  expect(onDocumentChange).toHaveBeenLastCalledWith({ content: "agent", reviewBaseline: "agent" });
  await act(async () => undo(view));
  expect(onDocumentChange).toHaveBeenLastCalledWith({ content: "agent", reviewBaseline: "old" });
  await act(async () => redo(view));
  expect(onDocumentChange).toHaveBeenLastCalledWith({ content: "agent", reviewBaseline: "agent" });
});

it.each(["input.type", "delete.backward"])("keeps the old side intact while editing new text (%s)", async (userEvent) => {
  const before = "heading\nold words\nfooter";
  const after = "heading\nnew words\nfooter";
  const view = await render({ diff: { before, after } });
  const position = after.indexOf("words");
  await act(async () => view.dispatch({ changes: { from: position, to: userEvent.startsWith("delete") ? position + 1 : position, insert: userEvent.startsWith("delete") ? "" : "中文😀" }, userEvent }));
  expect(getOriginalDoc(view.state).toString()).toBe(before);
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  expect(view.dom.querySelector(".cm-deletedChunk")?.textContent).toContain("old words");
  await act(async () => undo(view));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it.each(["delete.backward", "input.paste", "input", undefined])("synchronizes ordinary editing outside pending chunks and undoes both texts (%s)", async (userEvent) => {
  const before = "heading\nold words\nfooter";
  const after = "heading\nnew words\nfooter";
  const view = await render({ diff: { before, after } });
  const position = after.indexOf("footer");
  await act(async () => view.dispatch({ changes: { from: position, to: position + 6, insert: Text.of(["替换😀", "next"]) }, ...(userEvent === undefined ? {} : { userEvent }) }));
  expect(getOriginalDoc(view.state).toString()).toBe("heading\nold words\n替换😀\nnext");
  expect(view.state.doc.toString()).toBe("heading\nnew words\n替换😀\nnext");
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => undo(view));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it.each([
  ["", "new\n"],
  ["", "new"],
  ["", "\\begin{figure}\n  \\centering\n\\end{figure}"],
  ["heading\nfooter", "heading\nnew\nfooter"],
])("hides empty old-side rows for pure additions (%j → %j)", async (before, after) => {
  const view = await render({ diff: { before, after } });
  const deleted = view.dom.querySelector(".cm-deletedChunk");
  expect(deleted).not.toBeNull();
  expect(getComputedStyle(deleted as HTMLElement).display).toBe("none");
  expect(view.state.doc.toString()).toBe(after);
  expect(host?.querySelector('[aria-label="保留第 1 处变更"]')).not.toBeNull();
  expect(host?.querySelector('[aria-label="撤销第 1 处变更"]')).not.toBeNull();
});

it.each([
  ["old\n", ""],
  ["\n", "new"],
  ["heading\nold\nfooter", "heading\nnew\nfooter"],
  ["heading\n\nfooter", "heading\nfooter"],
])("keeps actual deleted lines visible, including empty lines (%j → %j)", async (before, after) => {
  const view = await render({ diff: { before, after } });
  const deleted = view.dom.querySelector(".cm-deletedChunk");
  expect(deleted?.querySelector(".cm-deletedLine")).not.toBeNull();
  expect(getComputedStyle(deleted as HTMLElement).display).not.toBe("none");
});

it("updates empty-baseline visibility across Keep, Undo and redo without replacing the view", async () => {
  const view = await render({ diff: { before: "", after: "new" } });
  expect(view.dom.classList.contains("cm-empty-review-baseline")).toBe(true);
  await act(async () => (host?.querySelector('[aria-label="Keep all"]') as HTMLButtonElement).click());
  expect(view.dom.classList.contains("cm-empty-review-baseline")).toBe(false);
  await act(async () => undo(view));
  expect(view.dom.classList.contains("cm-empty-review-baseline")).toBe(true);
  expect(getComputedStyle(view.dom.querySelector(".cm-deletedChunk") as HTMLElement).display).toBe("none");
  await act(async () => redo(view));
  expect(view.dom.classList.contains("cm-empty-review-baseline")).toBe(false);
});

it("clamps the restored cursor against the current text rather than the shorter old side", async () => {
  const view = await render({ initialCursor: 9, diff: { before: "x", after: "longer text" } });
  expect(view.state.selection.main.head).toBe(9);
});

it("preserves CRLF and Unicode through atomic review history", async () => {
  const before = "标题😀\r\n旧行\r\n末尾\r\n";
  const after = "标题😀\r\n新行中文\r\n末尾\r\n";
  const view = await render({ diff: { before, after } });
  await act(async () => (host?.querySelector('[aria-label="Undo all"]') as HTMLButtonElement).click());
  expect(view.state.doc.toString()).toBe(before);
  await act(async () => undo(view));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it.each(["应用当前变更", "撤销当前变更"])("preserves CRLF for a single chunk (%s)", async (label) => {
  const before = "标题😀\r\n旧行\r\n末尾\r\n";
  const after = "标题😀\r\n新行中文\r\n末尾\r\n";
  const view = await render({ diff: { before, after } });
  await act(async () => (host?.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click());
  const expected = label === "应用当前变更" ? after : before;
  expect(view.state.doc.toString()).toBe(expected);
  expect(getOriginalDoc(view.state).toString()).toBe(expected);
  await act(async () => undo(view));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it.each([
  ["", "new\n"], ["old\n", ""], ["a\nb", "a\nb\n"],
  ["a\nb\n", "a\nb"], ["a\nold\nrest", "a\nrest"],
  ["a\nrest", "a\nnew\nrest"], ["a\r\n", "a\r\nnew\r\n"],
])("preserves chunk line boundaries for single Keep/Undo (%j → %j)", async (before, after) => {
  const view = await render({ diff: { before, after } });
  await act(async () => (host?.querySelector('[aria-label="应用当前变更"]') as HTMLButtonElement).click());
  expect(getOriginalDoc(view.state).toString()).toBe(after);
  expect(view.state.doc.toString()).toBe(after);
  await act(async () => undo(view));
  expect(getOriginalDoc(view.state).toString()).toBe(before);
  await act(async () => (host?.querySelector('[aria-label="撤销当前变更"]') as HTMLButtonElement).click());
  expect(view.state.doc.toString()).toBe(before);
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
});

it("uses independent history items for consecutive single-chunk confirmations", async () => {
  const middle = "\nunchanged one\nunchanged two\nunchanged three\n";
  const before = `first old${middle}last old`;
  const after = `first new${middle}last new`;
  const view = await render({ diff: { before, after } });
  await act(async () => (host?.querySelector('[aria-label="应用当前变更"]') as HTMLButtonElement).click());
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => (host?.querySelector('[aria-label="应用当前变更"]') as HTMLButtonElement).click());
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
  await act(async () => undo(view));
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  expect(getOriginalDoc(view.state).toString()).toBe(`first new${middle}last old`);
  await act(async () => undo(view));
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it.each(["keep", "undo"] as const)("replays one chunk's %s without resolving its neighbor", async action => {
  const middle = "\nunchanged one\nunchanged two\nunchanged three\n";
  const before = `first old${middle}last old`, after = `first new${middle}last new`;
  const view = await render({ diff: { before, after } });
  const label = action === "keep" ? "保留第 1 处变更" : "撤销第 1 处变更";
  await act(async () => (host?.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click());
  const resolved = { content: view.state.doc.toString(), baseline: getOriginalDoc(view.state).toString() };
  expect(resolved).toEqual(action === "keep"
    ? { content: after, baseline: `first new${middle}last old` }
    : { content: `first old${middle}last new`, baseline: before });
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => expect(undo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
  expect(getChunks(view.state)?.chunks).toHaveLength(2);
  await act(async () => expect(redo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(resolved.content);
  expect(getOriginalDoc(view.state).toString()).toBe(resolved.baseline);
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
});

it.each(["fromB", "endB"] as const)("preserves old text when inserting at a pending chunk's %s boundary", async boundary => {
  const before = "heading\nold words\nfooter", after = "heading\nnew words\nfooter";
  const view = await render({ diff: { before, after } });
  const chunk = getChunks(view.state)?.chunks[0];
  if (!chunk) throw new Error("Missing pending chunk");
  const position = chunk[boundary];
  await act(async () => view.dispatch({ changes: { from: position, insert: Text.of(["边界😀\r", "继续"]) }, userEvent: "input.paste" }));
  const edited = after.slice(0, position) + "边界😀\r\n继续" + after.slice(position);
  expect(view.state.doc.toString()).toBe(edited);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => expect(undo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(after);
  await act(async () => expect(redo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(edited);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it("merges cross-chunk edits while preserving both old regions and their reversible baseline mapping", async () => {
  const middle = "\nunchanged one\nunchanged two\nunchanged three\n";
  const before = `first old${middle}last old`, after = `first new${middle}last new`;
  const view = await render({ diff: { before, after } });
  const chunks = getChunks(view.state)?.chunks;
  if (!chunks?.[0] || !chunks[1]) throw new Error("Missing pending chunks");
  await act(async () => view.dispatch({ changes: { from: chunks[0]!.fromB + 6, to: after.length,
    insert: Text.of(["替换😀\r", "多行"]) }, userEvent: "input.paste" }));
  expect(view.state.doc.toString()).toBe("first 替换😀\r\n多行");
  expect(getOriginalDoc(view.state).toString()).toBe("first old\nlast old");
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => expect(undo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
  expect(getChunks(view.state)?.chunks).toHaveLength(2);
  await act(async () => expect(redo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe("first 替换😀\r\n多行");
  expect(getOriginalDoc(view.state).toString()).toBe("first old\nlast old");
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
});

it("preserves pending old text when a replacement crosses ordinary and changed lines", async () => {
  const before = "prefix\nold\nstable\ntail";
  const after = "prefix\nnew\nstable\ntail";
  const view = await render({ diff: { before, after } });
  await act(async () => view.dispatch({ changes: { from: 0, to: after.indexOf("tail"), insert: "replaced\n" }, userEvent: "input.paste" }));
  expect(view.state.doc.toString()).toBe("replaced\ntail");
  expect(getOriginalDoc(view.state).toString()).toBe("replaced\nold\ntail");
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => undo(view));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it("does not remove a purely deleted old chunk when editing across its empty new side", async () => {
  const before = "prefix\ndeleted\nstable\ntail";
  const after = "prefix\nstable\ntail";
  const view = await render({ diff: { before, after } });
  await act(async () => view.dispatch({ changes: { from: 0, to: after.indexOf("tail") }, userEvent: "delete.selection" }));
  expect(view.state.doc.toString()).toBe("tail");
  expect(getOriginalDoc(view.state).toString()).toBe("deleted\ntail");
  await act(async () => undo(view));
  expect(view.state.doc.toString()).toBe(after);
  expect(getOriginalDoc(view.state).toString()).toBe(before);
});

it("creates no Diff for ordinary editing before an Agent transaction", async () => {
  const view = await render();
  await act(async () => view.dispatch({ changes: { from: 0, to: 3, insert: "typed" }, userEvent: "input.type" }));
  expect(getOriginalDoc(view.state).toString()).toBe("typed");
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
  const port = createWritingEditorSessionPort(view, "manuscript:main.tex");
  const expected = port.read();
  if (!expected) throw new Error("Missing editor snapshot");
  await act(async () => expect(port.apply({ operationId: "agent-on-typed", expected, text: "agent on typed" }).status).toBe("applied"));
  expect(getOriginalDoc(view.state).toString()).toBe("typed");
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => undo(view));
  expect(view.state.doc.toString()).toBe("typed");
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
  await act(async () => redo(view));
  expect(view.state.doc.toString()).toBe("agent on typed");
  expect(getOriginalDoc(view.state).toString()).toBe("typed");
  port.dispose();
});

it("updates the cursor index and stops navigation at both ends", async () => {
  const middle = "\nunchanged one\nunchanged two\nunchanged three\n";
  const before = `first old${middle}last old`;
  const after = `first new${middle}last new`;
  const view = await render({ diff: { before, after } });
  const chunks = getChunks(view.state)?.chunks;
  if (!chunks?.[0] || !chunks[1]) throw new Error("Missing chunks");
  await act(async () => view.dispatch({ selection: { anchor: chunks[1]!.fromB + 2 } }));
  expect(host?.querySelector('[aria-label="当前变更位置"]')?.textContent).toBe("2/2");
  const cursor = view.state.selection.main.head;
  await act(async () => (host?.querySelector('[aria-label="下一处变更"]') as HTMLButtonElement).click());
  expect(view.state.selection.main.head).toBe(cursor);
  await act(async () => (host?.querySelector('[aria-label="上一处变更"]') as HTMLButtonElement).click());
  expect(view.state.selection.main.head).toBe(chunks[0].fromB);
  expect(host?.querySelector('[aria-label="当前变更位置"]')?.textContent).toBe("1/2");
  await act(async () => (host?.querySelector('[aria-label="上一处变更"]') as HTMLButtonElement).click());
  expect(view.state.selection.main.head).toBe(chunks[0].fromB);
});
