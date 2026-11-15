import type { AgentApplicationScope, AgentApplicationState, AgentWorkspaceBuffer } from "@research-assistant/core/agent";
import type { createAgentApplicationGateway } from "@research-assistant/data/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";
import type { createWritingEditorRestoration } from "../editor/editorRestoration";
import type { WritingApplicationLease } from "./writingProposalApplication";

export function canRollbackApplication(state: AgentApplicationState): boolean {
  return ["prepared","applying","recoveryRequired"].includes(state.status)
    && state.files.length > 0
    && state.files.every(file => file.phase !== "conflict" && (file.target.kind === "disk" || file.phase !== "dispatched"));
}
/** Compensation may advance phases, never replace the original frozen target or receipt. */
function sameRollbackPlan(before: AgentApplicationState, after: AgentApplicationState): boolean {
  return (["conversationId", "manuscriptId", "proposalId", "operationId"] as const).every(key => before.scope[key] === after.scope[key])
    && before.files.length === after.files.length && before.files.every(file => {
      const next = after.files.find(next => next.path === file.path);
      const sameTarget = next && (file.target.kind === "disk" ? next.target.kind === "disk" : next.target.kind === "editor"
        && next.target.sessionId === file.target.sessionId && next.target.revision === file.target.revision
        && next.target.resultRevision === file.target.resultRevision);
      return !!sameTarget && !!next
        && (file.phase === "pending" ? next.phase === "pending" : file.phase === "restored" ? next.phase === "restored"
          : next.phase === file.phase || next.phase === "restored");
    });
}
function covered(state: AgentApplicationState, buffers: readonly AgentWorkspaceBuffer[], checkpointed: boolean): boolean {
  return state.files.every(file => {
    const buffer = buffers.find(buffer => buffer.path === file.path);
    return file.target.kind === "disk" ? !buffer : !!buffer
      && (checkpointed || file.phase === "restored" || buffer.sessionId === file.target.sessionId);
  });
}

/** Explicit interrupted rollback. Completed application undo is a separate operation. */
export async function rollbackWritingApplication(
  scope: AgentApplicationScope,
  gateway: ReturnType<typeof createAgentApplicationGateway>,
  acquire: (scope: AgentApplicationScope) => Promise<WritingApplicationLease | null>,
  editor?: ReturnType<typeof createWritingEditorRestoration>,
): Promise<EditorApplicationResult> {
  const lease = await acquire(scope);
  if (!lease) return {kind:"unavailable"};
  let known: AgentApplicationState | null = null;
  let result: EditorApplicationResult = {kind:"unavailable"};
  async function rollback(current: WritingApplicationLease): Promise<EditorApplicationResult> {
    const initial = await gateway.execute({action:"read",scope});
    if (initial.kind !== "state") return {kind:"unconfirmed",state:null};
    known = initial;
    if (!current.isCurrent()) return {kind:"unavailable"};
    if (initial.status === "rolledBack") return {kind:"state",state:initial};
    const hasEditors = initial.files.some(file => file.target.kind === "editor");
    const buffers = current.readBuffers ? current.readBuffers() : current.buffers;
    if (!canRollbackApplication(initial) || !buffers || !covered(initial, buffers, !!current.prepareUndoResume)
      || (hasEditors && !editor)) return {kind:"unavailable"};
    try {
      if (hasEditors && editor) {
        // Existing intents are reconciled from their real receipts before fresh
        // admission. Missing intents are read only; recovery never dispatches.
        for (const file of initial.files.filter(file => file.target.kind === "editor" && file.phase === "acknowledged")) {
          if (!current.isCurrent()) return {kind:"unconfirmed",state:known};
          const recovered = await editor.recover(scope, file.path);
          if (recovered.kind !== "state" || !sameRollbackPlan(known, recovered.state)) return {kind:"unconfirmed",state:known};
          known = recovered.state;
        }
        if (!current.isCurrent()) return {kind:"unconfirmed",state:known};
        if (known.status === "rolledBack") return {kind:"state",state:known};
        const checkpointVersions = current.prepareUndoResume ? await current.prepareUndoResume() : undefined;
        const fresh = current.readBuffers ? current.readBuffers() : current.buffers;
        if (!current.isCurrent() || !fresh) return {kind:"unconfirmed",state:known};
        const prepared = await gateway.execute({action:"prepareRollback",scope,buffers:fresh,
          ...(checkpointVersions ? {checkpointVersions} : {})});
        if (prepared.kind !== "state" || !sameRollbackPlan(known, prepared)) return {kind:"unconfirmed",state:known};
        known = prepared;
        if (known.status === "rolledBack") return {kind:"state",state:known};
        if (!canRollbackApplication(known)) return {kind:"unconfirmed",state:known};
        for (const file of [...known.files].reverse()) {
          if (file.target.kind !== "editor" || file.phase !== "acknowledged") continue;
          if (!current.isCurrent()) return {kind:"unconfirmed",state:known};
          const restored = await editor.restore(scope,file.path,checkpointVersions?.find(proof => proof.path === file.path));
          if ("state" in restored && restored.state && sameRollbackPlan(known, restored.state)) known = restored.state;
          if (restored.kind !== "state" || !sameRollbackPlan(known, restored.state)
            || !restored.state.files.some(item=>item.path===file.path && item.phase==="restored")) return {kind:"unconfirmed",state:known};
        }
      }
      if (!current.isCurrent()) return {kind:"unconfirmed",state:known};
      // Input remains possible under the lease. Capture fresh CAS after editor
      // compensation so a later input cannot be followed by restoring disk files.
      const checkpointVersions = hasEditors && current.prepareUndoResume ? await current.prepareUndoResume() : undefined;
      const fresh = current.readBuffers ? current.readBuffers() : current.buffers;
      if (!current.isCurrent() || !fresh) return {kind:"unconfirmed",state:known};
      const rolledBack = await gateway.execute(hasEditors ? {action:"rollbackRemainder",scope,buffers:fresh,
        ...(checkpointVersions ? {checkpointVersions} : {})} : {action:"rollbackDisk",scope});
      return rolledBack.kind === "state" && rolledBack.status === "rolledBack" && sameRollbackPlan(known, rolledBack)
        ? {kind:"state",state:rolledBack} : {kind:"unconfirmed",state:known};
    } catch {
      // Physical progress may already be durable. Read it, never retry writes.
      try {const latest = await gateway.execute({action:"read",scope}); if (latest.kind === "state" && sameRollbackPlan(known, latest)) known = latest;}
      catch { /* Retain the last verified journal state when the read also fails. */ }
      return {kind:"unconfirmed",state:known};
    }
  }
  try {result = await rollback(lease);}
  catch {result = {kind:"unconfirmed",state:known};}
  finally {
    try {await lease.refresh();}
    catch {result = {kind:"unconfirmed",state:"state" in result ? result.state : known};}
    finally {lease.release();}
  }
  return result;
}
