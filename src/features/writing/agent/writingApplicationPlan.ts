import type { AgentApplicationState, AgentWorkspaceBuffer, AgentUndoCheckpointVersion } from "@research-assistant/core/agent";

export function samePlan(before: AgentApplicationState, after: AgentApplicationState): boolean {
  if ((["conversationId", "manuscriptId", "proposalId", "operationId"] as const)
    .some(key => before.scope[key] !== after.scope[key])) return false;
  if (before.files.length !== after.files.length) return false;
  const nextFiles = new Map(after.files.map(file => [file.path, file]));
  return before.files.every(file => {
    const next = nextFiles.get(file.path);
    if (!next || next.target.kind !== file.target.kind) return false;
    if (file.phase === "acknowledged" && next.phase !== "acknowledged") return false;
    return file.target.kind === "disk" || (next.target.kind === "editor"
      && next.target.sessionId === file.target.sessionId && next.target.revision === file.target.revision);
  });
}
export function covered(state: AgentApplicationState, buffers: readonly AgentWorkspaceBuffer[]): boolean {
  const byPath = new Map(buffers.map(buffer => [buffer.path, buffer]));
  if (byPath.size !== buffers.length) return false;
  return state.files.every(file => {
    const buffer = byPath.get(file.path);
    return file.target.kind === "disk" ? !buffer : buffer?.sessionId === file.target.sessionId
      && buffer.revision === file.target.revision;
  });
}

/** Native whole-plan preflight can renew a departed owner before any dispatch.
 * An edit in the same live session remains a conflict, even if text is identical. */
export function coveredPending(state: AgentApplicationState, buffers: readonly AgentWorkspaceBuffer[]): boolean {
  if (!state.files.length || state.files.some(file => file.phase !== "pending")) return false;
  const byPath = new Map(buffers.map(buffer => [buffer.path, buffer]));
  if (byPath.size !== buffers.length) return false;
  return state.files.every(file => {
    const buffer = byPath.get(file.path);
    return file.target.kind === "disk" ? !buffer : !!buffer && file.target.resultRevision === null
      && (buffer.sessionId !== file.target.sessionId || buffer.revision === file.target.revision);
  });
}

/** Only the native admission reply may change wholly pending editor CAS targets. */
export function samePendingPlan(before: AgentApplicationState, after: AgentApplicationState, buffers: readonly AgentWorkspaceBuffer[]): boolean {
  if (after.status !== "applying" || !coveredPending(before, buffers) || !coveredPending(after, buffers) || !covered(after, buffers)
    || before.files.length !== after.files.length || (["conversationId", "manuscriptId", "proposalId", "operationId"] as const)
      .some(key => before.scope[key] !== after.scope[key])) return false;
  const next = new Map(after.files.map(file => [file.path, file]));
  return next.size === after.files.length && before.files.every(file => next.get(file.path)?.target.kind === file.target.kind);
}

/** A checkpoint may prove a rebuilt owner, but never changes an observed receipt. */
export function coveredUndoResume(state: AgentApplicationState, buffers: readonly AgentWorkspaceBuffer[], versions: readonly AgentUndoCheckpointVersion[]): boolean {
  if (!state.files.some(file => file.phase === "pending") || state.files.some(file => !["pending", "acknowledged"].includes(file.phase))) return false;
  const byPath = new Map(buffers.map(buffer => [buffer.path, buffer]));
  const proofs = new Map(versions.map(version => [version.path, version]));
  if (byPath.size !== buffers.length || proofs.size !== versions.length) return false;
  const entirelyPending = state.files.every(file => file.phase === "pending");
  return state.files.every(file => {
    const buffer = byPath.get(file.path);
    if (file.target.kind === "disk") return !buffer;
    const revision = file.phase === "pending" ? file.target.revision : file.target.resultRevision;
    if (!buffer || revision === null) return false;
    return file.target.sessionId === buffer.sessionId ? buffer.revision === revision
      : entirelyPending || proofs.has(file.path);
  });
}

/** Admission renews Pending CAS only; acknowledged session/revisions stay frozen. */
export function sameUndoResumePlan(before: AgentApplicationState, after: AgentApplicationState, buffers: readonly AgentWorkspaceBuffer[], versions: readonly AgentUndoCheckpointVersion[]): boolean {
  if (after.status !== "applying" || !coveredUndoResume(before, buffers, versions) || before.files.length !== after.files.length
    || (["conversationId", "manuscriptId", "proposalId", "operationId"] as const).some(key => before.scope[key] !== after.scope[key])) return false;
  const next = new Map(after.files.map(file => [file.path, file]));
  if (next.size !== after.files.length) return false;
  return before.files.every(file => {
    const admitted = next.get(file.path), buffer = buffers.find(buffer => buffer.path === file.path);
    if (!admitted || admitted.phase !== file.phase || admitted.target.kind !== file.target.kind) return false;
    if (file.target.kind === "disk") return true;
    if (admitted.target.kind !== "editor") return false;
    if (file.phase === "acknowledged") return admitted.target.sessionId === file.target.sessionId
      && admitted.target.revision === file.target.revision && admitted.target.resultRevision === file.target.resultRevision;
    return admitted.target.resultRevision === null && admitted.target.sessionId === buffer?.sessionId && admitted.target.revision === buffer.revision;
  });
}
