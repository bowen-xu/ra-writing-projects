import {
  decodeAgentWritingQueuedCompactionPreview, type AgentWritingQueuedCompactionPreview,
  type AgentWritingQueueCancelRequest,
} from "@research-assistant/core/agent";
import type {AgentInputQueueGateway, AgentInputQueuePreviewGateway, AgentSubmissionGateway, AgentTurnGateway, AgentWritingCompactionGateway} from "@research-assistant/data/agent";
import {
  acquireWritingSubmissionController, releaseWritingSubmissionController,
  type WritingQueueCancellationRecovery, type WritingQueueCancellationSnapshot,
} from "@research-assistant/workbench-sdk/agent-writing";
import type {WritingQueuedCompactionRecovery} from "./writingQueuedCompactionRecovery";

export interface WritingQueuedCompactionCancellationPorts {
  readonly ownerKey: string;
  readonly submission: AgentSubmissionGateway;
  readonly turns: AgentTurnGateway;
  readonly preview: AgentInputQueuePreviewGateway;
  readonly recovery: WritingQueueCancellationRecovery;
  readonly queue: Pick<AgentInputQueueGateway, "read">;
  readonly isAdmissionDisabled: () => boolean;
}
type Result = "active" | "pending" | "retired";
type Action = "check" | "retry" | "begin";
function matching(intent: AgentWritingQueueCancelRequest, original: WritingQueuedCompactionRecovery): boolean {
  return intent.conversationId === original.conversationId && intent.manuscriptId === original.manuscriptId
    && intent.inputId === original.inputId && intent.previewRequestId === original.requestId;
}

/** A domain consumer of the original Core cancellation owner. It keeps no
 * cancellation intent, storage key or execution owner of its own. */
export class WritingQueuedCompactionRetirement {
  private observed: AgentWritingQueuedCompactionPreview | null = null;
  private cancellation: WritingQueueCancellationSnapshot | undefined;
  private pending: Promise<Result> | null = null;
  constructor(private readonly gateway: AgentWritingCompactionGateway,
    private readonly ports: WritingQueuedCompactionCancellationPorts,
    private readonly current: (original: WritingQueuedCompactionRecovery) => boolean,
    private readonly changed: () => void) {}
  getCancellation = () => this.cancellation;
  hasProof = () => !!this.observed?.retirement;
  observe(value: AgentWritingQueuedCompactionPreview): void {
    this.observed = value;
  }
  reset(): void {this.observed = null; this.cancellation = undefined;}
  run(original: WritingQueuedCompactionRecovery, action: Action): Promise<Result> {
    if (this.pending) return this.pending;
    const work = this.reconcile(original, action);
    this.pending = work;
    return work.finally(() => {if (this.pending === work) {this.pending = null; this.changed();}});
  }
  private async read(original: WritingQueuedCompactionRecovery): Promise<AgentWritingQueuedCompactionPreview | null> {
    const value = await this.gateway.readWritingQueued({conversationId: original.conversationId,
      manuscriptId: original.manuscriptId, inputId: original.inputId, requestId: original.requestId});
    if (!this.current(original)) return null;
    if (value === null) return null;
    if (value?.kind !== "compact") throw new Error("COMPACTION_QUEUE_CLAIM_MISMATCH");
    const decoded = decodeAgentWritingQueuedCompactionPreview(value);
    if (decoded.requestId !== original.requestId || decoded.inputId !== original.inputId
      || decoded.preview.conversationId !== original.conversationId || decoded.preview.manuscriptId !== original.manuscriptId)
      throw new Error("COMPACTION_QUEUE_CLAIM_MISMATCH");
    this.observe(decoded);
    return decoded;
  }
  private async reconcile(original: WritingQueuedCompactionRecovery, action: Action): Promise<Result> {
    const ports = this.ports;
    const core = acquireWritingSubmissionController(ports.ownerKey, ports.submission, ports.turns,
      ports.preview, ports.recovery, ports.isAdmissionDisabled);
    const sync = () => {if (this.current(original)) {this.cancellation = core.getSnapshot().cancellation; this.changed();}};
    const detach = core.subscribe(sync);
    try {
      sync();
      let value = await this.read(original);
      if (!this.current(original)) return "pending";
      const cancellation = core.getSnapshot().cancellation;
      if (cancellation && !["idle", "ready"].includes(cancellation.phase)) {
        if (!cancellation.intent || !matching(cancellation.intent, original)) throw new Error("COMPACTION_QUEUE_CANCELLATION_PENDING");
        if (action === "check") await core.checkQueuedCancellation();
        else await core.retryQueuedCancellation(async () => {
          const claim = await this.read(original);
          if (!claim || !claim.current || claim.retirement || claim.outcome) return null;
          return {schemaVersion: 1, inputId: claim.inputId, preview: claim.preview, queue: claim.queue};
        });
        if (!this.current(original)) return "pending";
        sync(); value = await this.read(original);
      } else if (!value) return action === "begin" ? "pending" : "active";
      else if (action === "begin" && !value.retirement) {
        if (!value.current || value.outcome) return "pending";
        const queue = await ports.queue.read({conversationId: original.conversationId, manuscriptId: original.manuscriptId});
        if (!this.current(original) || queue.preparingInputId !== original.inputId) return "pending";
        const intent: AgentWritingQueueCancelRequest = {conversationId: original.conversationId, manuscriptId: original.manuscriptId,
          inputId: original.inputId, previewRequestId: original.requestId, requestId: crypto.randomUUID(), expectedRevision: queue.revision};
        await core.beginPreparedQueueCancellation(intent);
        if (!this.current(original)) return "pending";
        sync(); value = await this.read(original);
        // A busy Core owner may decline the new intent. Its existing work wins.
        if (!core.isQueuedCancellationCommitted(intent)) return "pending";
      }
      if (!this.current(original) || !value) return "pending";
      const state = core.getSnapshot().cancellation;
      if (state && !["idle", "ready"].includes(state.phase)) return "pending";
      if (value.retirement) return "retired";
      return value.current || value.outcome ? "active" : "pending";
    } finally {detach(); releaseWritingSubmissionController(ports.ownerKey, core);}
  }
}
