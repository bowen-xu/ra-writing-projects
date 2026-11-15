import type { AgentApplicationScope, AgentProposalRequest } from "@research-assistant/core/agent";
import type { WritingProposalApplicationGateways, useWritingProposalApplication } from "./useWritingProposalApplication";
import type { EditorApplicationResult } from "../editor/editorApplication";

export type UndoWritingProposal = (request: AgentProposalRequest) => Promise<EditorApplicationResult>;
export interface WritingCardUndoResult {
  readonly scope: AgentApplicationScope;
  readonly undoId: string;
  readonly result: EditorApplicationResult;
}

/** File-workspace command. A chat card supplies identity only; it never owns an
 * undo journal or installs historical text. Lost replies retain the same ID. */
export function createWritingCardUndo(gateways: WritingProposalApplicationGateways,
  actions: Pick<ReturnType<typeof useWritingProposalApplication>, "undo" | "startUndo" | "resumeUndo" | "recoverUndo">,
  onResult?: (value: WritingCardUndoResult) => void): UndoWritingProposal {
  const retained = new Map<string, string>();
  let busy = false;
  return async request => {
    if (busy) return { kind: "busy" };
    busy = true;
    const identity: { current: { scope: AgentApplicationScope; undoId: string } | null } = { current: null };
    async function execute(): Promise<EditorApplicationResult> {
      const original = await gateways.applications.find(request);
      if (!original || original.status !== "applied") return { kind: "unavailable" };
      const previous = await gateways.undos.find(original.scope);
      const key = JSON.stringify(original.scope);
      const canceled = previous?.result?.kind === "state" && previous.result.status === "rolledBack";
      let id = (canceled ? undefined : previous?.undoId) ?? retained.get(key);
      if (!id || (canceled && id === previous?.undoId)) id = crypto.randomUUID();
      retained.set(key, id);
      identity.current = { scope: original.scope, undoId: id };
      let state = canceled ? null : previous?.result;
      if (state?.kind === "state" && state.status === "recoveryRequired") {
        for (const file of state.files.filter(file => file.phase === "dispatched")) {
          const recovered = await actions.recoverUndo(original.scope, id, file.path);
          if (recovered.kind !== "state") return recovered;
          state = recovered.state;
        }
        return actions.resumeUndo(original.scope, id);
      }
      if (state?.kind === "state" && state.status === "prepared") return actions.startUndo(original.scope, id);
      return actions.undo(original.scope, id);
    }
    let result: EditorApplicationResult;
    try { result = await execute(); }
    catch { result = { kind: "unconfirmed", state: null }; }
    finally { busy = false; }
    if (identity.current) onResult?.({ ...identity.current, result });
    return result;
  };
}
