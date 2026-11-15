import {useCallback, useRef, type RefObject} from "react";
import type {AgentInputDraft, AgentSubmissionPreview, AgentWorkspaceBuffer} from "@research-assistant/core/agent";
import type {AgentWorkspaceGateway} from "@research-assistant/data/agent";
import { useAgentMountedGuard } from "@research-assistant/workbench-sdk/agent-presentation";
import type {WritingSubmissionController} from "@research-assistant/workbench-sdk/agent-writing";

interface FrozenWorkspace {
  readonly requestId: string;
  readonly buffers: readonly AgentWorkspaceBuffer[] | null;
  readonly draft: AgentInputDraft;
}
interface WorkspaceAttempt {
  readonly owner: WritingSubmissionController;
  readonly gateway: AgentWorkspaceGateway;
  readonly preview: AgentSubmissionPreview;
}
const samePreview = (a: AgentSubmissionPreview | null, b: AgentSubmissionPreview) => !!a
  && a.conversationId === b.conversationId && a.manuscriptId === b.manuscriptId && a.requestId === b.requestId
  && a.contextSnapshotId === b.contextSnapshotId && a.turnId === b.turnId;
const sameAttempt = (a: WorkspaceAttempt | null, b: WorkspaceAttempt) => !!a && a.owner === b.owner && a.gateway === b.gateway && samePreview(a.preview, b.preview);

/** UI cache for the existing submission owner. Read-only checks follow the
 * view; authorized work follows its original owner and original saved buffers. */
export function useWritingEditableWorkspace({gateway, controller, frozenWorkspace}: {
  readonly gateway: AgentWorkspaceGateway;
  readonly controller: RefObject<WritingSubmissionController | null>;
  readonly frozenWorkspace: RefObject<FrozenWorkspace | null>;
}) {
  const mounted = useAgentMountedGuard(), activeGateway = useRef(gateway);
  activeGateway.current = gateway;
  const ready = useRef<WorkspaceAttempt | null>(null);
  const pending = useRef<(WorkspaceAttempt & {readonly promise: Promise<boolean>}) | null>(null);
  return useCallback(async (input: AgentSubmissionPreview, options: {readonly restore?: boolean; readonly createMissing?: boolean;
    readonly owner?: WritingSubmissionController; readonly buffers?: readonly AgentWorkspaceBuffer[]} = {}): Promise<boolean> => {
    const authorized = !options.restore || options.createMissing === true;
    const owner = options.owner ?? controller.current; if (!owner) return false;
    const preview = structuredClone(input), attempt: WorkspaceAttempt = {owner, gateway, preview};
    const frozen = frozenWorkspace.current;
    const buffers = authorized && options.buffers !== undefined ? structuredClone(options.buffers)
      : frozen?.requestId === preview.requestId && frozen.buffers !== null ? structuredClone(frozen.buffers) : owner.getWorkspaceBuffers(preview.requestId);
    const viewing = () => mounted.current && controller.current === owner;
    const current = () => {
      const state = owner.getSnapshot();
      return (authorized || viewing()) && activeGateway.current === gateway && owner.isOriginalPreviewCurrent(attempt.preview)
        && (state.phase === "preview" || (state.phase === "error" && ["workspace", "start", "startRejected", "prepare"].includes(state.error ?? ""))
          || (state.phase === "preparing" && state.preparation?.knownCommitted === true));
    };
    if (!current()) return false;
    if (sameAttempt(pending.current, attempt)) return pending.current!.promise;
    const work = (async () => {
      try {
        if (!sameAttempt(ready.current, attempt)) {
          const scope = {conversationId: preview.conversationId, manuscriptId: preview.manuscriptId,
            requestId: preview.requestId, contextSnapshotId: preview.contextSnapshotId};
          if (options.restore) {
            try {await gateway.restore(scope);}
            catch (cause: unknown) {
              if (!current()) return false;
              if (cause !== "notFound" || !options.createMissing) throw cause;
              if (buffers === null) throw {code: "QUEUE_WORKSPACE_ORIGINAL_BUFFERS_MISSING"};
              await gateway.prepare({scope, buffers});
            }
          } else {
            if (buffers === null) throw {code: "QUEUE_WORKSPACE_ORIGINAL_BUFFERS_MISSING"};
            await gateway.prepare({scope, buffers});
          }
          if (!current()) return false;
          if (viewing()) ready.current = attempt;
        }
        if (!current()) return false;
        const acknowledged = await owner.observeWorkspacePreparation(preview.requestId, true);
        return current() && acknowledged;
      } catch (cause: unknown) {
        if (current()) await owner.observeWorkspacePreparation(preview.requestId, false, cause);
        return false;
      }
    })();
    pending.current = {...attempt, promise: work};
    try {return await work;} finally {if (pending.current?.promise === work) pending.current = null;}
  }, [controller, frozenWorkspace, gateway, mounted]);
}
