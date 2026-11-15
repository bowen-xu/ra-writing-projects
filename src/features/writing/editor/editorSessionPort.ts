import { EditorState, Text, Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { diff } from "@codemirror/merge";
import type { EditorView } from "@codemirror/view";
import type { AgentEditorEdit, AgentEditorEditResult, AgentEditorSessionPort, AgentEditorSnapshot } from "@research-assistant/core/agent";
import { captureWritingEditor } from "./editorSession";

function same(a: AgentEditorSnapshot, b: AgentEditorSnapshot): boolean {
  return a.documentKey === b.documentKey && a.sessionId === b.sessionId && a.revision === b.revision && a.text === b.text;
}
/** A single live view owns this adapter. Dispose before destroying it to invalidate reads
 * and writes, including a callback retained by an old manuscript host.
 */
export function createWritingEditorSessionPort(view: EditorView, documentKey: string): AgentEditorSessionPort & { dispose(): void } {
  return createWritingStateSessionPort({ documentKey, readState: () => view.state,
    isComposing: () => view.composing, dispatch: (transaction) => view.dispatch(transaction) });
}

interface WritingStateHost {
  readonly documentKey: string;
  readonly readState: () => EditorState;
  readonly isComposing: () => boolean;
  readonly dispatch: (transaction: Transaction) => void;
}

/** The file owner supplies the same state/transaction boundary with or without a visible view. */
export function createWritingStateSessionPort(host: WritingStateHost): AgentEditorSessionPort & { dispose(): void } {
  let receipt: { edit: AgentEditorEdit; result: Extract<AgentEditorEditResult, {status: "applied"}> } | null = null;
  let dispatching = false;
  let disposed = false;
  const read = (): AgentEditorSnapshot | null => disposed ? null : captureWritingEditor(host.readState(), host.documentKey);
  const readReceipt = (operationId: string) => !disposed && receipt?.edit.operationId === operationId
    ? {...receipt.result, snapshot:{...receipt.result.snapshot}} : null;
  return {
    dispose() { disposed = true; receipt = null; },
    read,
    readReceipt,
    apply(value) {
      // Keep one bounded receipt; older operations still fail their stale revision.
      const edit = { ...value, expected: { ...value.expected } };
      const current = read();
      if (!current || host.isComposing() || host.readState().facet(EditorState.readOnly) || dispatching) return {status:"unavailable"};
      if (!edit.operationId || edit.operationId.length > 128 || edit.text.length > 4 * 1024 * 1024 || current.text.length > 4 * 1024 * 1024) return {status:"conflict"};
      if (receipt?.edit.operationId === edit.operationId) {
        return same(receipt.edit.expected, edit.expected) && receipt.edit.text === edit.text
          ? { ...receipt.result, snapshot: { ...receipt.result.snapshot } } : {status:"conflict"};
      }
      if (!same(current, edit.expected) || edit.text === current.text) return {status:"conflict"};
      const changes = diff(current.text, edit.text, {scanLimit:1000, timeout:50})
        .map(c => ({from:c.fromA, to:c.toA, insert:Text.of(edit.text.slice(c.fromB, c.toB).split("\n"))}));
      // Explicit Text preserves CRLF bytes. Validate filters before dispatch.
      const transaction = host.readState().update({ changes, annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.agent")] });
      if (transaction.newDoc.toString() !== edit.text) return {status:"conflict"};
      dispatching = true;
      const observeResult = () => {
        const snapshot = read();
        if (!snapshot || snapshot.sessionId !== current.sessionId || snapshot.revision === current.revision || snapshot.text !== edit.text) return null;
        const result = {status:"applied" as const, operationId:edit.operationId, snapshot};
        receipt = {edit, result};
        return {...result, snapshot:{...snapshot}};
      };
      try {
        host.dispatch(transaction);
        return observeResult() ?? {status:"unconfirmed"};
      } catch {
        // A hook can fail after the transaction lands. Capture strictly observed
        // evidence for read-only reconciliation, but do not report normal success.
        try { observeResult(); } catch { /* No readable state: retain uncertainty. */ }
        return {status:"unconfirmed"};
      } finally { dispatching = false; }
    },
  };
}
