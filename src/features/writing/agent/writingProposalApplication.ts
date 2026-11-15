import { samePlan, covered } from "./writingApplicationPlan";
import type { AgentApplicationScope, AgentApplicationState, AgentWorkspaceBuffer, AgentUndoCheckpointVersion } from "@research-assistant/core/agent";
import type { createAgentApplicationGateway } from "@research-assistant/data/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";

/** Acquired after pending saves settle. The host excludes saves, navigation and
 * competing mutations until release. Text input remains protected by editor CAS.
 * refresh must invalidate disk-derived caches without replacing live editor text.
 */
export interface WritingApplicationLease {
  readonly buffers: readonly AgentWorkspaceBuffer[];
  /** Current live bytes while the same lease remains held; initial buffers stay frozen. */
  readBuffers?(): readonly AgentWorkspaceBuffer[] | null;
  prepareUndoResume?(): Promise<readonly AgentUndoCheckpointVersion[]>;
  isCurrent(): boolean;
  refresh(): Promise<void>;
  release(): void;
}
type Gateway = ReturnType<typeof createAgentApplicationGateway>;
interface EditorApplication {
  apply(scope: AgentApplicationScope, path: string): Promise<EditorApplicationResult>;
}
/** One instance per workspace, independent of review-dialog lifetime. A retry
 * resumes only an operation whose journal is still entirely pending; once any
 * target was dispatched, it reports the durable operation and waits for the
 * explicit reconciliation controls. The caller retains its operation ID even
 * if all IPC responses are lost.
 */
export function createWritingProposalApplication(
  gateway: Gateway,
  editor: EditorApplication,
  acquire: (scope: AgentApplicationScope) => Promise<WritingApplicationLease | null>,
) {
  let busy = false;
  return { async apply(value: AgentApplicationScope): Promise<EditorApplicationResult> {
    if (busy) return {kind: "busy"};
    busy = true;
    const scope = {...value};
    let operationScope = scope;
    let lease: WritingApplicationLease | null = null;
    let began = false;
    let result: EditorApplicationResult = {kind: "unavailable"};
    async function run(): Promise<EditorApplicationResult> {
      // The lookup endpoint identifies a proposal and deliberately does not
      // accept an application operation ID. Passing the full application
      // scope would be rejected by the strict native request decoder before
      // the application journal can be created.
      const existing = await gateway.find({conversationId: scope.conversationId,
        manuscriptId: scope.manuscriptId, proposalId: scope.proposalId});
      // A previous attempt may have committed its journal before the renderer
      // lost the response. Only a completely untouched `applying` or
      // `recoveryRequired` operation can be resumed here. Once any file is
      // dispatched, the operation must
      // stay read-only and use the explicit reconciliation controls instead;
      // accepting again must never replay a side effect.
      let runScope = operationScope;
      let state: AgentApplicationState;
      let buffers: readonly AgentWorkspaceBuffer[];
      if (existing) {
        const allPending = existing.files.length > 0 && existing.files.every(file => file.phase === "pending");
        if (!allPending || !["applying", "recoveryRequired"].includes(existing.status)) {
          return {kind: "state", state: existing};
        }
        runScope = existing.scope;
        operationScope = runScope;
        lease = await acquire(runScope);
        if (!lease || !lease.isCurrent()) return {kind: "unavailable"};
        buffers = lease.buffers.map(buffer => ({...buffer}));
        began = true;
        const resumed = await gateway.execute({action: "resume", scope: runScope, buffers});
        if (resumed.kind !== "state" || resumed.status !== "applying") {
          return {kind: "unconfirmed", state: resumed.kind === "state" ? resumed : null};
        }
        state = resumed;
        if (!covered(state, buffers)) return {kind: "unconfirmed", state};
      } else {
        lease = await acquire(runScope);
        if (!lease || !lease.isCurrent()) return {kind: "unavailable"};
        buffers = lease.buffers.map(buffer => ({...buffer}));
        began = true;
        const admitted = await gateway.execute({action: "begin", scope: runScope, buffers});
        if (admitted.kind !== "state") return {kind: "unconfirmed", state: null};
        // The native begin command commits the durable application intent and
        // transitions it to `applying` before any per-file dispatch. A fresh
        // response may therefore be either the historical `prepared` state or
        // the live `applying` state. Existing operations are still returned by
        // the lookup above and must never be redispatched here.
        if (admitted.status !== "prepared" && admitted.status !== "applying") return {kind: "state", state: admitted};
        state = admitted;
        if (!covered(state, buffers)) return {kind: "unconfirmed", state};
      }
      for (const original of state.files) {
        if (!lease.isCurrent() || !["prepared", "applying"].includes(state.status)) {
          return state.status === "applied" ? {kind: "state", state} : {kind: "unconfirmed", state};
        }
        const file = state.files.find(entry => entry.path === original.path);
        if (file?.phase === "acknowledged") continue;
        if (!file || file.phase !== "pending") return {kind: "unconfirmed", state};
        const outcome: EditorApplicationResult = file.target.kind === "editor"
          ? await editor.apply(runScope, file.path)
          : await gateway.execute({action: "applyDisk", scope: runScope, path: file.path}).then(response =>
            response.kind === "state" ? {kind: "state", state: response} : {kind: "unconfirmed", state: null});
        if (outcome.kind !== "state") return outcome.kind === "unconfirmed" ? outcome : {kind: "unconfirmed", state};
        if (!samePlan(state, outcome.state)) return {kind: "unconfirmed", state: null};
        state = outcome.state;
        if (state.files.find(entry => entry.path === file.path)?.phase !== "acknowledged") {
          return {kind: "unconfirmed", state};
        }
      }
      return state.status === "applied" ? {kind: "state", state} : {kind: "unconfirmed", state};
    }
    try { result = await run(); }
    catch {
      let state: AgentApplicationState | null = null;
      if (began) {
        try {
          const response = await gateway.execute({action: "read", scope: operationScope});
          if (response.kind === "state") state = response;
        } catch { /* Missing evidence remains uncertain; never start a new operation. */ }
      }
      result = {kind: "unconfirmed", state};
    } finally {
      // Async acquisition happens inside run; retain the lease through refresh.
      const held = lease as WritingApplicationLease | null;
      try {
        if (began && held) {
          try { await held.refresh(); }
          catch { result = {kind: "unconfirmed", state: "state" in result ? result.state : null}; }
        }
      } finally {
        try { held?.release(); } finally { busy = false; }
      }
    }
    return result;
  }};
}
