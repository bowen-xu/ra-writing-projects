import type { AgentApplicationState, AgentProposalRequest, AgentProposalReview } from "@research-assistant/core/agent";
import type { AgentSessionGateway, AgentProposalGateway, AgentWorkspaceReviewGateway } from "@research-assistant/data/agent";
import { AgentConversationController } from "@research-assistant/workbench-sdk/agent-conversations";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-sdk/agent-writing";
import type { AcceptWritingProposal } from "./useWritingProposalApplication";
import type { EditorApplicationResult } from "../editor/editorApplication";
import { WritingDeliveryConflict } from "./WritingDeliveryConflict";
import type { WritingDeliveryToolRequest, WritingDeliveryToolResult } from "@research-assistant/workbench-sdk/agent-delivery";

export interface WritingAgentDeliverySnapshot extends WritingSubmissionAdmission {
  readonly status: "watching" | "waiting" | "applying" | "error";
  readonly failureStage: "history" | "proposal" | "files" | "application" | "acknowledgement" | null;
  readonly application?: AgentApplicationState;
  readonly conflict?: true;
  readonly toolOwned?: true;
}
interface Entry {
  readonly admission: WritingSubmissionAdmission;
  readonly history: AgentConversationController;
  operationId: string;
  unsubscribe: () => void;
  status: WritingAgentDeliverySnapshot["status"];
  completed: boolean;
  failureStage: WritingAgentDeliverySnapshot["failureStage"];
  application: AgentApplicationState | null;
  proposal: AgentProposalReview | null;
  conflict: boolean;
  toolRequest?: WritingDeliveryToolRequest;
  toolDelivered?: boolean;
  readonly delivered: Map<string, WritingDeliveryToolRequest["binding"]>;
  failedBinding?: WritingDeliveryToolRequest["binding"];
}
interface Options {
  readonly sessions: AgentSessionGateway;
  readonly proposals: Pick<AgentProposalGateway, "latest" | "publish">;
  readonly reviews: Pick<AgentWorkspaceReviewGateway, "review" | "reviewBinding">;
  readonly canApply: (manuscriptId: string) => boolean;
  readonly canResume?: (manuscriptId: string) => boolean;
  /** Observation/settlement outlives a command's temporary exclusive lease. */
  readonly isCurrentManuscript?: (manuscriptId: string) => boolean;
  readonly prepareFiles: (proposal: AgentProposalReview) => Promise<void>;
  readonly accept: AcceptWritingProposal;
  readonly findApplication?: (request: AgentProposalRequest) => Promise<AgentApplicationState | null>;
  readonly acknowledge: (admission: WritingSubmissionAdmission) => Promise<void>;
  readonly rejectProposal?: (request: AgentProposalRequest) => Promise<AgentProposalReview>;
  readonly reportTool?: (result: WritingDeliveryToolResult) => Promise<void>;
}
function key(value: WritingSubmissionAdmission): string { return JSON.stringify(value.scope); }
function matches(proposal: AgentProposalReview, admission: WritingSubmissionAdmission, expected?: WritingDeliveryToolRequest["binding"]): boolean {
  const binding = proposal.review.binding;
  return binding.turnId === admission.turnId && (Object.keys(admission.scope) as (keyof typeof admission.scope)[])
    .every((field) => binding.scope[field] === admission.scope[field])
    && (!expected || (binding.leaseId === expected.leaseId && binding.manifestHash === expected.manifestHash));
}

/** Workspace business adapter for admitted turns. Reuses shared durable history
 * and native proposal application; owns neither Agent execution nor file text.
 * Chat mounting/selection never registers delivery. Failed delivery is explicit
 * retry, and native journals remain authoritative across retries and restarts.
 */
export class WritingAgentFileDelivery {
  private readonly entries = new Map<string, Entry>();
  private readonly finished = new Map<string, string>();
  private readonly savedApplications = new Map<string, AgentApplicationState>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly WritingAgentDeliverySnapshot[] = [];
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  constructor(private readonly options: Options) {}
  private available(entry: Entry): boolean {
    return this.options.canApply(entry.admission.scope.manuscriptId) || !!(entry.toolRequest && entry.application
      && this.options.canResume?.(entry.admission.scope.manuscriptId));
  }
  /** React strict-effect reconnect is a fresh subscription lifetime. */
  connect(): () => void { this.disposed = false; return () => this.dispose(); }
  readonly getSnapshot = (): readonly WritingAgentDeliverySnapshot[] => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(): void {
    this.snapshot = [...this.entries.values()].map(({ admission, status, failureStage, application, conflict, toolRequest }) => ({ ...admission, status, failureStage,
      ...(application ? { application } : {}), ...(conflict ? { conflict: true as const } : {}),
      ...(toolRequest ? { toolOwned: true as const } : {}) }));
    for (const listener of this.listeners) listener();
  }
  readonly register = (value: WritingSubmissionAdmission): void => {
    if (this.disposed) return;
    const admission = structuredClone(value), identity = key(admission);
    const previous = this.entries.get(identity);
    if (previous || this.finished.has(identity)) {
      if ((previous?.admission.turnId ?? this.finished.get(identity)) !== admission.turnId) throw new Error("Admitted turn identity changed");
      return;
    }
    const history = new AgentConversationController(this.options.sessions);
    const entry: Entry = { admission, history, operationId: crypto.randomUUID(), delivered: new Map(), unsubscribe: () => undefined, status: "watching", completed: false, failureStage: null, application: null, proposal: null, conflict: false };
    this.entries.set(identity, entry);
    entry.unsubscribe = history.subscribe(() => this.observe(entry));
    this.publish();
    void history.open(admission.scope.conversationId);
  };
  /** A live finalization tool, not a completed chat, owns this delivery. */
  readonly requestTool = (request: WritingDeliveryToolRequest): void => {
    request = structuredClone(request);
    this.register(request);
    const entry = this.entries.get(key(request));
    if (!entry || entry.admission.turnId !== request.turnId || !this.options.reportTool) return;
    if (entry.toolRequest || entry.status === "applying") return;
    entry.toolRequest = request;
    const confirmed = entry.delivered.get(request.requestId);
    if (confirmed) {
      if (confirmed.leaseId === request.binding.leaseId && confirmed.manifestHash === request.binding.manifestHash) {
        void this.reportTool(entry, true, "File delivery already confirmed.", true);
      } else {
        entry.status = "error"; entry.failureStage = "files"; this.publish();
        void this.reportTool(entry, false, "A different file delivery request cannot reuse the previous receipt. Reconcile the original operation; no new delivery was dispatched.", false, true);
      }
      return;
    }
    if ((entry.status === "error" && (!entry.failedBinding || entry.failedBinding.leaseId !== request.binding.leaseId
      || entry.failedBinding.manifestHash !== request.binding.manifestHash)) || entry.delivered.size >= 256
      || [...entry.delivered.values()].some(binding => binding.leaseId === request.binding.leaseId)) {
      entry.status = "error"; entry.failureStage = "files"; this.publish();
      void this.reportTool(entry, false, "The prior file delivery must be reconciled or use a different workspace. No new delivery was dispatched.", false, true);
      return;
    }
    if (entry.toolDelivered) {
      entry.toolDelivered = false; entry.operationId = crypto.randomUUID();
      entry.application = null; entry.proposal = null; entry.conflict = false;
    }
    entry.completed = true;
    if (!this.available(entry)) {
      entry.status = "error"; entry.failureStage = "files"; this.publish();
      void this.reportTool(entry, false, "File owner is unavailable or another operation needs reconciliation. No new delivery was dispatched.");
      return;
    }
    entry.status = "waiting"; this.publish(); this.enqueue(entry);
  };
  private async reportTool(entry: Entry, complete: boolean, message: string, duplicate = false, preserveFailure = false): Promise<void> {
    const request = entry.toolRequest;
    if (!request || !this.options.reportTool) return;
    try { await this.options.reportTool({ request, complete, message: message.slice(0, 900) }); }
    catch { /* A dropped runner cannot authorize replay; keep the file journal. */ }
    if (entry.toolRequest === request) delete entry.toolRequest;
    if (duplicate) return;
    if (!complete) {
      if (!preserveFailure) entry.failedBinding = structuredClone(request.binding);
      entry.history.pause();
    }
    if (complete) {
      delete entry.failedBinding;
      entry.toolDelivered = true; entry.delivered.set(request.requestId, structuredClone(request.binding));
      // A duplicate acknowledgement must not clear a later, unrelated
      // delivery failure or resume its paused history.
      if (entry.status !== "error") {
        entry.status = "watching"; entry.completed = false; this.publish(); void entry.history.resume();
      }
    }
  }
  private observe(entry: Entry): void {
    if (this.disposed || entry.status !== "watching") return;
    const snapshot = entry.history.getSnapshot();
    if (snapshot.status === "error") { entry.status = "error"; entry.failureStage = "history"; this.publish(); return; }
    if (snapshot.status !== "ready") return;
    const turn = snapshot.projection?.turns.get(entry.admission.turnId);
    if (!turn) return;
    if (turn.contextSnapshotId !== entry.admission.scope.contextSnapshotId) {
      entry.status = "error"; entry.failureStage = "history"; entry.history.pause(); this.publish(); return;
    }
    if (!turn.outcome) return;
    // Partial failed/canceled runs remain immutable review candidates; they do
    // not automatically change the manuscript under a completion policy.
    entry.completed = turn.outcome === "completed";
    entry.status = "waiting";
    entry.history.pause();
    this.publish();
    this.enqueue(entry);
  }
  private enqueue(entry: Entry): void {
    this.tail = this.tail.then(() => this.deliver(entry));
  }
  /** Drain already queued work without dispatching or retrying pending entries. */
  readonly flush = async (): Promise<void> => {
    while (true) {
      const tail = this.tail;
      await tail;
      if (this.tail === tail) return;
    }
  };
  private async deliver(entry: Entry): Promise<void> {
    const current = () => !this.disposed && this.entries.get(key(entry.admission)) === entry;
    if (!current() || entry.status !== "waiting" || !this.available(entry)) return;
    entry.status = "applying"; entry.failureStage = null; entry.conflict = false; this.publish();
    let stage: NonNullable<WritingAgentDeliverySnapshot["failureStage"]> = "proposal";
    try {
      if (entry.toolDelivered) { stage = "acknowledgement"; await this.finish(entry); return; }
      if (!entry.completed) { stage = "acknowledgement"; await this.finish(entry); return; }
      const scope = entry.admission.scope;
      let proposal = await this.options.proposals.latest(scope);
      if (!current()) return;
      if (proposal && entry.toolRequest && !matches(proposal, entry.admission, entry.toolRequest.binding)) proposal = null;
      if (!proposal) {
        const review = entry.toolRequest ? await this.options.reviews.reviewBinding(entry.toolRequest.binding)
          : await this.options.reviews.review(scope);
        if (!current()) return;
        if (review.binding.turnId !== entry.admission.turnId || (Object.keys(scope) as (keyof typeof scope)[])
          .some((field) => review.binding.scope[field] !== scope[field])) throw new Error("Completed workspace identity changed");
        if (entry.toolRequest && (review.binding.leaseId !== entry.toolRequest.binding.leaseId
          || review.binding.manifestHash !== entry.toolRequest.binding.manifestHash)) throw new Error("Delivery workspace identity changed");
        if (!review.changes.length) { stage = "acknowledgement"; await this.finish(entry); return; }
        proposal = await this.options.proposals.publish(review);
      }
      if (!current()) return;
      if (!matches(proposal, entry.admission, entry.toolRequest?.binding)) throw new Error("Completed proposal identity changed");
      entry.proposal = proposal;
      const saved = [...this.savedApplications.values()].find(state => state.scope.manuscriptId === scope.manuscriptId
        && state.scope.conversationId === scope.conversationId && state.scope.proposalId === proposal.proposalId);
      if (saved) {
        // An explicit file-owned recovery already completed formal saving.
        // Only settle the surviving delivery; do not prepare or replay text.
        entry.application = structuredClone(saved); stage = "acknowledgement"; await this.finish(entry); return;
      }
      if (proposal.status === "undone" && this.options.findApplication) {
        stage = "application";
        const saved = await this.options.findApplication({ manuscriptId: scope.manuscriptId,
          conversationId: scope.conversationId, proposalId: proposal.proposalId });
        if (!current()) return;
        if (saved && ((["manuscriptId", "conversationId"] as const).some(field => saved.scope[field] !== scope[field])
          || saved.scope.proposalId !== proposal.proposalId)) throw new Error("Application journal identity changed");
        if (saved?.status === "rolledBack") {
          // Native compensation is terminal, but the interrupted host may not
          // have formally saved restored editor bytes. Startup only observes.
          entry.application = structuredClone(saved); entry.status = "error"; entry.failureStage = stage; this.publish(); return;
        }
      }
      if (proposal.status === "rejected" || proposal.status === "undone") { stage = "acknowledgement"; await this.finish(entry); return; }
      if (!this.available(entry)) { entry.status = "waiting"; this.publish(); return; }
      stage = "files";
      await this.options.prepareFiles(proposal);
      if (!current()) return;
      if (!this.available(entry)) { entry.status = "waiting"; this.publish(); return; }
      const operation = { manuscriptId: scope.manuscriptId, conversationId: scope.conversationId,
        proposalId: proposal.proposalId, operationId: entry.operationId };
      stage = "application";
      const result = await this.options.accept(operation);
      if (!current()) return;
      // Native lookup validates the proposal identity and the coordinator may
      // adopt its existing journal's operation ID. Per-file dispatch still
      // validates that original operation; a new receiver ID cannot replace it.
      if ("state" in result && result.state) {
        const state = result.state;
        if ((["manuscriptId", "conversationId", "proposalId"] as const)
          .some((field) => state.scope[field] !== operation[field])) throw new Error("Application receipt identity changed");
        entry.application = structuredClone(state);
      }
      if (result.kind === "state" && result.state.status === "applied") { stage = "acknowledgement"; await this.finish(entry); }
      else { entry.status = !entry.toolRequest && (result.kind === "busy" || result.kind === "unavailable") ? "waiting" : "error";
        entry.failureStage = entry.status === "error" ? stage : null; this.publish();
        await this.reportTool(entry, false, `File delivery ${result.kind}; stage=${stage}. Some targets may already have changed. Reconcile the original operation; do not replay the patch.`); }
    } catch (reason) {
      if (current()) { entry.status = "error"; entry.failureStage = stage;
        entry.conflict = stage === "files" && reason instanceof WritingDeliveryConflict; this.publish();
        await this.reportTool(entry, false, `File delivery failed at ${stage}: ${reason instanceof Error ? reason.message : String(reason)}. Reconcile the original operation; do not replay the patch.`); }
    }
  }
  /** Called when the manuscript host becomes available; never retries errors. */
  readonly resume = (): void => {
    for (const entry of this.entries.values()) if (entry.status === "waiting") this.enqueue(entry);
  };
  readonly retry = (value: WritingSubmissionAdmission): void => {
    const entry = this.entries.get(key(value));
    if (!entry || entry.status !== "error" || this.disposed) return;
    if (entry.failureStage === "acknowledgement" && (entry.proposal?.status === "rejected"
      || (entry.application && ["applied", "rolledBack"].includes(entry.application.status)))) {
      void this.settle(entry); return;
    }
    entry.failureStage = null;
    if (entry.completed) { entry.status = "waiting"; this.publish(); this.enqueue(entry); }
    else { entry.status = "watching"; this.publish(); void entry.history.resume(); }
  };
  /** Rejecting changes only proposal metadata. Recheck the journal immediately;
   * any admitted application must use the existing recovery path instead. */
  readonly discardConflict = async (value: WritingSubmissionAdmission): Promise<void> => {
    const entry = this.entries.get(key(value));
    if (this.disposed || !entry?.conflict || entry.status !== "error" || !entry.proposal
      || !this.options.findApplication || !this.options.rejectProposal
      || !(this.options.isCurrentManuscript ?? this.options.canApply)(value.scope.manuscriptId)) return;
    const request = { manuscriptId: value.scope.manuscriptId, conversationId: value.scope.conversationId, proposalId: entry.proposal.proposalId };
    const current = () => !this.disposed && this.entries.get(key(value)) === entry;
    entry.status = "applying"; this.publish();
    try {
      const existing = await this.options.findApplication(request);
      if (!current()) return;
      if (!(this.options.isCurrentManuscript ?? this.options.canApply)(value.scope.manuscriptId)) {
        entry.status = "error"; this.publish(); return;
      }
      if (existing) {
        if ((["manuscriptId", "conversationId", "proposalId"] as const).some(field => existing.scope[field] !== request[field])) throw new Error("Application identity changed");
        entry.application = existing; entry.conflict = false; entry.failureStage = "application";
        entry.status = "error"; this.publish(); return;
      }
      const rejected = await this.options.rejectProposal(request);
      if (!current()) return;
      if (!matches(rejected, entry.admission) || rejected.proposalId !== request.proposalId || rejected.status !== "rejected") throw new Error("Rejection identity changed");
      entry.proposal = rejected; entry.conflict = false; entry.failureStage = "acknowledgement";
      await this.finish(entry);
    } catch { if (current()) { entry.status = "error"; this.publish(); } }
  };
  /** Recovery controls project the existing journal. Only a protected command
   * that also completed formal saving may settle delivery; a read is unconfirmed. */
  readonly recordApplication = async (value: WritingSubmissionAdmission, result: EditorApplicationResult): Promise<void> => {
    const entry = this.entries.get(key(value));
    if (!entry || this.disposed || entry.admission.turnId !== value.turnId || !entry.completed
      || entry.status === "applying" || !(this.options.isCurrentManuscript ?? this.options.canApply)(entry.admission.scope.manuscriptId)
      || !entry.application || !("state" in result) || !result.state) return;
    const state = result.state;
    if ((["manuscriptId", "conversationId", "proposalId", "operationId"] as const)
      .some(field => state.scope[field] !== entry.application?.scope[field])) return;
    entry.application = structuredClone(state);
    entry.status = "error"; entry.failureStage = "application"; this.publish();
    if (result.kind === "state" && ["applied", "rolledBack"].includes(state.status)) await this.settle(entry);
  };
  /** A discovered file journal may outlive every chat delivery row. Retain only
   * a protected command's saved result for surviving delivery acknowledgement. */
  readonly recordRecoveredApplication = async (application: AgentApplicationState, result: EditorApplicationResult): Promise<void> => {
    if (this.disposed || !(this.options.isCurrentManuscript ?? this.options.canApply)(application.scope.manuscriptId)
      || !("state" in result) || !result.state
      || (["manuscriptId", "conversationId", "proposalId", "operationId"] as const)
        .some(field => application.scope[field] !== result.state?.scope[field])) return;
    if (result.kind === "state" && ["applied", "rolledBack"].includes(result.state.status)) {
      this.savedApplications.set(application.scope.operationId, structuredClone(result.state));
      if (this.savedApplications.size > 256) this.savedApplications.delete(this.savedApplications.keys().next().value as string);
    }
    for (const entry of this.entries.values()) {
      if (entry.application?.scope.operationId === application.scope.operationId) await this.recordApplication(entry.admission, result);
    }
  };
  private async settle(entry: Entry): Promise<void> {
    if (this.disposed || this.entries.get(key(entry.admission)) !== entry || entry.status === "applying"
      || !(this.options.isCurrentManuscript ?? this.options.canApply)(entry.admission.scope.manuscriptId)) return;
    entry.status = "applying"; entry.failureStage = "acknowledgement"; this.publish();
    try { await this.finish(entry); }
    catch {
      if (!this.disposed && this.entries.get(key(entry.admission)) === entry) {
        entry.status = "error"; this.publish();
      }
    }
  }
  private async finish(entry: Entry): Promise<void> {
    if (entry.toolRequest) {
      await this.reportTool(entry, true, "File delivery and required persistence completed.");
      return;
    }
    // Native proof, not a UI success flag, settles durable delivery. Lost replies
    // retain this entry for explicit retry and native application reconciliation.
    await this.options.acknowledge(entry.admission);
    if (this.disposed || this.entries.get(key(entry.admission)) !== entry) return;
    entry.unsubscribe(); entry.history.dispose();
    this.entries.delete(key(entry.admission));
    if (entry.application) this.savedApplications.delete(entry.application.scope.operationId);
    this.finished.set(key(entry.admission), entry.admission.turnId);
    // Bounded session deduplication only; eviction cannot bypass native journals.
    if (this.finished.size > 256) this.finished.delete(this.finished.keys().next().value as string);
    this.publish();
  }
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) { entry.unsubscribe(); entry.history.dispose(); }
    this.entries.clear(); this.finished.clear(); this.savedApplications.clear(); this.snapshot = []; this.listeners.clear();
  }
}
