import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { expect, it } from "vitest";
import { captureWritingEditor, writingEditorIdentity } from "./editorSession";

it("keeps identity across selection changes and changes revision on edits and undo", () => {
  let state = EditorState.create({ doc: "original", extensions: [writingEditorIdentity, history()] });
  const initial = captureWritingEditor(state, "paper:main.tex");
  state = state.update({ selection: { anchor: 3 } }).state;
  expect(captureWritingEditor(state, "paper:main.tex")).toEqual(initial);
  state = state.update({ changes: { from: 0, to: 8, insert: "unsaved 中文" } }).state;
  const changed = captureWritingEditor(state, "paper:main.tex");
  expect(changed.sessionId).toBe(initial.sessionId);
  expect(changed.revision).not.toBe(initial.revision);
  expect(changed.text).toBe("unsaved 中文");
  expect(undo({ state, dispatch: (transaction) => { state = transaction.state; } })).toBe(true);
  const reverted = captureWritingEditor(state, "paper:main.tex");
  expect(reverted.text).toBe("original");
  expect(reverted.sessionId).toBe(initial.sessionId);
  expect(reverted.revision).not.toBe(initial.revision);
  expect(reverted.revision).not.toBe(changed.revision);
  expect(initial.text).toBe("original");
});

it("isolates reopened documents even when their path and text are identical", () => {
  const make = () => captureWritingEditor(EditorState.create({ doc: "same", extensions: [writingEditorIdentity] }), "paper:main.tex");
  const first = make(); const second = make();
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(first.revision).not.toBe(second.revision);
});

it("captures the active non-empty selection as UTF-16 context offsets", () => {
  let state = EditorState.create({ doc: "甲🧬乙", extensions: [writingEditorIdentity] });
  state = state.update({ selection: { anchor: 1, head: 3 } }).state;
  expect(captureWritingEditor(state, "paper:main.tex").selection).toEqual({ startUtf16: 1, endUtf16: 3 });
  state = state.update({ selection: { anchor: 1 } }).state;
  expect(captureWritingEditor(state, "paper:main.tex").selection).toBeUndefined();
});
