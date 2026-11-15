import { decodeAgentUndoRequest, type AgentApplicationScope, type AgentApplicationState } from "@research-assistant/core/agent";
import type { createAgentUndoGateway } from "@research-assistant/data/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";
import type { createWritingEditorRestoration } from "../editor/editorRestoration";
import type { WritingApplicationLease } from "./writingProposalApplication";

export function canRollbackUndo(state: AgentApplicationState): boolean {
  return (state.status === "applying" || state.status === "recoveryRequired")
    && state.files.length > 0
    && state.files.every(file => file.phase !== "conflict" && (file.target.kind === "disk" || file.phase !== "dispatched"));
}

/** The workspace owns exclusion across accept, resume, recovery and rollback. */
export async function rollbackWritingUndo(
  scope: AgentApplicationScope, undoId: string, gateway: ReturnType<typeof createAgentUndoGateway>,
  acquire: (scope: AgentApplicationScope) => Promise<WritingApplicationLease | null>,
  editor?: ReturnType<typeof createWritingEditorRestoration>,
): Promise<EditorApplicationResult> {
  const identity = decodeAgentUndoRequest({scope, undoId, command: {action: "read"}});
  const ownership: {lease: WritingApplicationLease | null} = {lease: null};
  let state: AgentApplicationState | null = null, touched = false;
  let result: EditorApplicationResult = {kind: "unavailable"};
  async function execute(): Promise<EditorApplicationResult> {
    const read = (await gateway.execute(identity)).result;
    if (read?.kind !== "state") return {kind: "unconfirmed", state: null};
    state = read;
    if (state.status === "rolledBack") return {kind: "state", state};
    const hasEditors = state.files.some(file => file.target.kind === "editor");
    if (!canRollbackUndo(state) || (hasEditors && !editor)) return {kind: "unavailable"};
    const lease = await acquire(identity.scope);
    ownership.lease = lease;
    if (!lease || !lease.isCurrent()
      || lease.buffers.some(buffer => state?.files.some(file => file.target.kind === "disk" && file.path === buffer.path))) return {kind: "unavailable"};
    const current = lease;
    if (hasEditors) {
      if (!current.readBuffers || !current.readBuffers()) return {kind: "unavailable"};
      touched = true;
      // Recover historical receipts before admission. This never dispatches a
      // missing restoration intent, even when its original response was lost.
      for (const file of state.files.filter(file => file.target.kind === "editor" && file.phase === "acknowledged")) {
        if (!current.isCurrent()) return {kind: "unconfirmed", state};
        const recovered = await editor!.recover({...identity.scope, operationId: identity.undoId}, file.path);
        if (recovered.kind !== "state") return recovered;
        state = recovered.state;
      }
      if (state.status === "rolledBack") return {kind: "state", state};
      const checkpointVersions = current.prepareUndoResume ? await current.prepareUndoResume() : [];
      const buffers = current.readBuffers();
      if (!current.isCurrent() || !buffers) return {kind: "unconfirmed", state};
      const prepared = (await gateway.execute({...identity, command: {action: "prepareRollback", buffers, ...(current.prepareUndoResume ? { checkpointVersions } : {})}})).result;
      if (prepared?.kind !== "state") return {kind: "unconfirmed", state};
      state = prepared;
      if (state.status === "rolledBack") return {kind: "state", state};
      if (!canRollbackUndo(state)) return {kind: "unconfirmed", state};
      for (const file of [...state.files].reverse()) {
        if (file.target.kind !== "editor" || file.phase !== "acknowledged") continue;
        if (!current.isCurrent()) return {kind: "unconfirmed", state};
        const restored = await editor!.restore({...identity.scope, operationId: identity.undoId}, file.path, checkpointVersions.find(proof => proof.path === file.path));
        if (restored.kind !== "state") return restored;
        state = restored.state;
        if (!state.files.some(f => f.path === file.path && f.phase === "restored")) return {kind: "unconfirmed", state};
      }
      if (state.status === "rolledBack") return {kind: "state", state};
    }
    if (!current.isCurrent()) return {kind: "unconfirmed", state};
    const checkpointVersions = current.prepareUndoResume ? await current.prepareUndoResume() : [];
    if (!current.isCurrent()) return {kind: "unconfirmed", state};
    const buffers = current.readBuffers ? current.readBuffers() : current.buffers;
    if (!buffers) return {kind: "unconfirmed", state};
    touched = true;
    const response = (await gateway.execute({...identity, command: {action: "rollbackDisk", buffers, ...(current.prepareUndoResume ? { checkpointVersions } : {})}})).result;
    if (response?.kind === "state") state = response;
    return response?.kind === "state" && response.status === "rolledBack" ? {kind: "state", state: response} : {kind: "unconfirmed", state};
  }
  try {result = await execute();}
  catch {result = {kind: "unconfirmed", state};}
  finally {
    try {
      if (touched && ownership.lease) {
        try {await ownership.lease.refresh();} catch {result = {kind: "unconfirmed", state};}
      }
    } finally {ownership.lease?.release();}
  }
  return result;
}
