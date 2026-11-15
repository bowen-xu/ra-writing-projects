import { StateField, type EditorState } from "@codemirror/state";
import type { AgentEditorSnapshot } from "@research-assistant/core/agent";

export type WritingEditorSnapshot = AgentEditorSnapshot;
export type ReadWritingEditorSnapshot = () => WritingEditorSnapshot | null;

/** Identity belongs to this live document state, not a render or submit action. */
export const writingEditorIdentity = StateField.define<{ readonly sessionId: string; readonly revision: string }>({
  create: () => ({ sessionId: crypto.randomUUID(), revision: crypto.randomUUID() }),
  update: (identity, transaction) => transaction.docChanged
    ? { sessionId: identity.sessionId, revision: crypto.randomUUID() } : identity,
});

export function captureWritingEditor(state: EditorState, documentKey: string): WritingEditorSnapshot {
  const range = state.selection.main;
  return {
    documentKey,
    ...state.field(writingEditorIdentity),
    text: state.doc.toString(),
    ...(range.empty ? {} : { selection: { startUtf16: range.from, endUtf16: range.to } }),
  };
}
