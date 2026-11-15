import { decodeAgentUndoRequest, type AgentApplicationScope, type AgentApplicationState } from "@research-assistant/core/agent";
import type { createAgentUndoGateway } from "@research-assistant/data/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";
import type { WritingApplicationLease } from "./writingProposalApplication";
import { covered, coveredPending, coveredUndoResume, samePendingPlan, samePlan, sameUndoResumePlan } from "./writingApplicationPlan";

/** One per workspace. Repeated apply reads history; explicit start starts a
 * prepared baseline. Resume revalidates reconciled progress before pending work.
 * The host retains undoId even after all transport responses are lost. */
export function createWritingProposalUndo(
  gateway: ReturnType<typeof createAgentUndoGateway>,
  editor: (scope: AgentApplicationScope, undoId: string) => { apply(path: string): Promise<EditorApplicationResult> },
  acquire: (scope: AgentApplicationScope) => Promise<WritingApplicationLease | null>,
) {
  let busy = false;
  async function run(value: AgentApplicationScope, id: string, mode: "apply" | "start" | "resume"): Promise<EditorApplicationResult> {
    if (busy) return { kind: "busy" };
    const identity = decodeAgentUndoRequest({ scope: value, undoId: id, command: { action: "read" } });
    busy = true;
    let lease: WritingApplicationLease | null = null, touched = false;
    let known: AgentApplicationState | null = null;
    let result: EditorApplicationResult = { kind: "unavailable" };
    async function execute(): Promise<EditorApplicationResult> {
      const prior = (await gateway.execute(identity)).result;
      if (prior) {
        if (prior.kind !== "state") return { kind: "unconfirmed", state: null };
        known = prior;
        if (mode === "apply" || prior.status !== (mode === "resume" ? "recoveryRequired" : "prepared")) return { kind: "state", state: prior };
        if (mode === "resume" && (!prior.files.some(f => f.phase === "pending")
          || prior.files.some(f => f.phase !== "pending" && f.phase !== "acknowledged"))) return {kind: "unconfirmed", state: prior};
      } else if (mode !== "apply") return { kind: "unavailable" };
      lease = await acquire(identity.scope);
      if (!lease || !lease.isCurrent()) return { kind: "unavailable" };
      const checkpointVersions = mode === "resume" && lease.prepareUndoResume ? await lease.prepareUndoResume() : [];
      const currentBuffers = lease.readBuffers ? lease.readBuffers() : lease.buffers;
      if (!currentBuffers || !lease.isCurrent()) return { kind: "unconfirmed", state: known };
      const buffers = currentBuffers.map(b => ({ ...b }));
      if (!prior) {
        touched = true;
        const prepared = (await gateway.execute({ ...identity, command: { action: "prepare", buffers } })).result;
        if (!prepared || prepared.kind !== "state") return { kind: "unconfirmed", state: known };
        known = prepared;
      }
      if (!known || known.status !== (mode === "resume" ? "recoveryRequired" : "prepared")) return { kind: "unconfirmed", state: known };
      if (mode === "resume" && known.files.some(file => file.phase === "acknowledged" && file.target.kind === "editor" && file.target.resultRevision === null)) return {kind: "unconfirmed", state: known};
      if (!(mode === "resume" ? coveredUndoResume(known, buffers, checkpointVersions)
        : covered(known, buffers) || coveredPending(known, buffers)) || !lease.isCurrent()) return { kind: "unconfirmed", state: known };
      touched = true;
      const started = (await gateway.execute({ ...identity, command: mode === "resume" ? { action: "resume", buffers, checkpointVersions } : { action: "start", buffers } })).result;
      if (!started || started.kind !== "state" || !(mode === "resume" ? sameUndoResumePlan(known, started, buffers, checkpointVersions)
        : samePlan(known, started) || samePendingPlan(known, started, buffers))) return { kind: "unconfirmed", state: known };
      known = started;
      if (known.status !== "applying") return { kind: "state", state: known };
      let state: AgentApplicationState = started;
      const executor = editor(identity.scope, identity.undoId);
      for (const original of started.files) {
        if (!lease.isCurrent()) return { kind: "unconfirmed", state: state };
        const file = state.files.find(f => f.path === original.path);
        if (mode === "resume" && file?.phase === "acknowledged") continue;
        if (state.status !== "applying" || !file || file.phase !== "pending") return { kind: "unconfirmed", state: state };
        const next: EditorApplicationResult = file.target.kind === "editor" ? await executor.apply(file.path)
          : await gateway.execute({ ...identity, command: { action: "applyDisk", path: file.path } }).then(({ result }): EditorApplicationResult =>
            result?.kind === "state" ? { kind: "state", state: result } : { kind: "unconfirmed", state: state });
        if (next.kind !== "state") return next.kind === "unconfirmed" ? next : { kind: "unconfirmed", state: state };
        if (!samePlan(state, next.state)) return { kind: "unconfirmed", state: state };
        state = next.state;
        known = state;
        if (state.files.find(f => f.path === file.path)?.phase !== "acknowledged") return { kind: "unconfirmed", state: state };
      }
      return state.status === "applied" ? { kind: "state", state: state } : { kind: "unconfirmed", state: state };
    }
    try { result = await execute(); }
    catch { result = { kind: "unconfirmed", state: known }; }
    finally {
      const held = lease as WritingApplicationLease | null;
      try {
        if (touched && !(result.kind === "state" && result.state.status === "applied")) {
          try {
            const stopped = (await gateway.execute({ ...identity, command: { action: "defer" } })).result;
            if (stopped?.kind === "state") result = { kind: "unconfirmed", state: stopped };
          } catch { /* Unknown completion remains visible; never replay. */ }
        }
        if (touched && held) {
          try { await held.refresh(); }
          catch { result = { kind: "unconfirmed", state: "state" in result ? result.state : known }; }
        }
      } finally { try { held?.release(); } finally { busy = false; } }
    }
    return result;
  }
  return {
    apply(scope: AgentApplicationScope, undoId: string) { return run(scope, undoId, "apply"); },
    start(scope: AgentApplicationScope, undoId: string) { return run(scope, undoId, "start"); },
    resume(scope: AgentApplicationScope, undoId: string) { return run(scope, undoId, "resume"); },
  };
}
