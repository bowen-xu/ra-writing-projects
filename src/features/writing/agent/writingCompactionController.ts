import {
  agentWritingCompactionStartRequest, type AgentConversationProjection, type AgentSubmissionPreview,
  decodeAgentWritingQueuedCompactionReadRequest,
  sameAgentWritingCompactionPrepareRequest,
  type AgentWritingCompactionPrepareRequest, type AgentWritingCompactionPreview, type AgentWritingReceipt,
  type AgentWritingQueuedCompactionPrepareRequest, type AgentWritingQueuedCompactionPreview,
  type AgentWritingQueuedCompactionSettleRequest, type AgentWritingQueuedCompactionSettleResponse,
} from "@research-assistant/core/agent";
import type { AgentSessionGateway, AgentTurnGateway, AgentWritingCompactionGateway } from "@research-assistant/data/agent";
import { AgentConversationController } from "@research-assistant/workbench-sdk/agent-conversations";
import { ReviewedSubmissionController, type ReviewedSubmissionSnapshot } from "@research-assistant/workbench-sdk/agent-writing";
import { ReviewedSubmissionOwnerRegistry } from "@research-assistant/workbench-sdk/agent-writing";
import { decodeWritingCompactionReceipt } from "./writingCompactionReceipt";
import {isWritingQueuedCompactionRecovery, type WritingQueuedCompactionRecovery} from "./writingQueuedCompactionRecovery";
import {WritingManualCompactionPreparation} from "./writingManualCompactionPreparation";
import type {WritingCompactionReceiptStore} from "./writingCompactionReceipt";
import type {WritingDraftAcknowledgmentPort} from "@research-assistant/workbench-sdk/agent-writing";
import type { ConversationDraftAcknowledgmentToken } from "@research-assistant/workbench-sdk/agent-drafts";
import type {AgentExecutionMode} from "@research-assistant/core/agent";
import {WritingCompactionAdmission, WritingCompactionAdmissionClosed} from "./writingCompactionAdmission";
import {writingManualPreparationRejection} from "./writingManualCompactionRecovery";
import {WritingQueuedCompactionRetirement, type WritingQueuedCompactionCancellationPorts} from "./writingQueuedCompactionRetirement";

export type WritingCompactionRequest = AgentWritingCompactionPrepareRequest & {
  readonly queued?: Pick<AgentWritingQueuedCompactionPrepareRequest, "inputId" | "expectedQueueRevision" | "previousRequestId">;
};
export type WritingCompactionReceipt = AgentWritingReceipt & { readonly inputId?: string };
type Preview = AgentSubmissionPreview & { readonly expectedRevision: number; readonly queued?: AgentWritingQueuedCompactionPreview };
export type WritingCompactionSnapshot = ReviewedSubmissionSnapshot<WritingCompactionRequest, WritingCompactionReceipt, Preview>;
export interface QueuedCompactionSettlement {
  readonly phase: "pending" | "settling" | "error" | "settled";
  readonly request: AgentWritingQueuedCompactionSettleRequest | null;
  readonly cause: unknown;
  readonly result: AgentWritingQueuedCompactionSettleResponse | null;
}
export interface WritingCompactionScope {
  readonly identity: string;
  readonly conversationId: string;
  readonly manuscriptId: string;
}
export interface WritingCompactionPorts {
  readonly gateway: AgentWritingCompactionGateway;
  readonly turns: AgentTurnGateway;
  readonly history: AgentSessionGateway;
  readonly projection?: AgentConversationProjection;
  readonly receipts?: WritingCompactionReceiptStore;
  readonly draftAcknowledgments?: WritingDraftAcknowledgmentPort;
  readonly isAdmissionDisabled?: () => boolean;
  readonly cancellation?: WritingQueuedCompactionCancellationPorts;
}
function rejected(error: unknown): boolean {
  if (error instanceof WritingCompactionAdmissionClosed) return true;
  return !!error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && ["invalidInput", "hostUnavailable", "confirmationMismatch",
      "unsupportedModel", "modelUnavailable", "historyChanged", "busy"].includes(error.code);
}
function flatten(value: AgentWritingCompactionPreview): Preview {
  return { ...value.preview, expectedRevision: value.expectedRevision };
}
function flattenQueued(value: AgentWritingQueuedCompactionPreview): Preview {
  return {...value.preview, expectedRevision: value.expectedRevision, queued: value};
}

/** Thin host adapter over the existing review coordinator and history reader.
 * Native remains the sole execution owner; view detachment never interrupts it. */
export class WritingCompactionController extends ReviewedSubmissionController<WritingCompactionRequest, WritingCompactionReceipt, Preview> {
  readonly history: AgentConversationController;
  private watching = false;
  private readonly detachHistory: () => void;
  private readonly detachReview: () => void;
  private settlement: QueuedCompactionSettlement = {phase: "pending", request: null, cause: null, result: null};
  private queuedRecovery: WritingQueuedCompactionRecovery | null = null;
  private queuedReserved = false;
  private queuedUnsentClearRemoved = false;
  private readonly queuedAdmission: WritingCompactionAdmission;
  private readonly startAttempt: {replayUnknown: boolean};
  private readonly prepareAttempt: {replayUnknown: boolean};
  private readonly retirement: WritingQueuedCompactionRetirement | null;
  private receiptStore: WritingCompactionReceiptStore | undefined;
  getQueuedCancellation = () => this.retirement?.getCancellation();
  hasQueuedRetirementProof = () => this.retirement?.hasProof() ?? false;
  getQueuedAdmission = () => this.queuedAdmission.getSnapshot();
  hasQueuedReservation = (): boolean => this.queuedReserved;
  queuedReservedDurably(): void { this.queuedReserved = true; }
  getQueuedRecovery = (): WritingQueuedCompactionRecovery | null => this.queuedRecovery;
  setQueuedRecovery(value: WritingQueuedCompactionRecovery | null, restored = false): void {
    if (value?.requestId !== this.queuedRecovery?.requestId && value) {
      this.settlement = {phase: "pending", request: null, cause: null, result: null}; this.queuedReserved = false;
      this.queuedUnsentClearRemoved = false;
      this.queuedAdmission.reset();
      this.prepareAttempt.replayUnknown = false;
    }
    if (restored && value) {this.queuedAdmission.restore(true); this.prepareAttempt.replayUnknown = true;}
    this.queuedRecovery = value; this.update({});
  }
  getSettlement = (): QueuedCompactionSettlement => this.settlement;
  queuedPending = (): boolean => !!(this.queuedRecovery || this.getSnapshot().request?.queued || this.getSnapshot().recoveryReceipt?.inputId
    || this.getSnapshot().preview?.queued) && this.settlement.phase !== "settled";
  queuedIssue(cause: unknown): void { this.settlement = {...this.settlement, phase: "error", cause}; this.update({}); }
  queuedSettled(): void { this.settlement = {...this.settlement, phase: "settled", cause: null}; this.update({}); }
  async checkQueuedAdmissionBlock(): Promise<boolean> {
    const recovery = this.queuedRecovery, observed = this.queuedAdmission.getSnapshot();
    if (!recovery || observed.blockedBeforeDispatch !== "prepare" || observed.prepareMayHaveDispatched) return false;
    const value = await this.queuedGateway.readWritingQueued({conversationId: recovery.conversationId, manuscriptId: recovery.manuscriptId,
      requestId: recovery.requestId, inputId: recovery.inputId});
    const current = this.queuedAdmission.getSnapshot();
    return value === null && recovery === this.queuedRecovery && current.blockedBeforeDispatch === "prepare" && !current.prepareMayHaveDispatched;
  }
  async discardQueuedAdmissionBlock(store: WritingCompactionReceiptStore): Promise<boolean> {
    try {
      if (!await this.checkQueuedAdmissionBlock()) return false;
      const recovery = this.queuedRecovery!;
      const saved = store.read(recovery);
      if ((!saved && !this.queuedUnsentClearRemoved) || saved && (!isWritingQueuedCompactionRecovery(saved)
        || saved.requestId !== recovery.requestId || saved.inputId !== recovery.inputId
        || saved.conversationId !== recovery.conversationId || saved.manuscriptId !== recovery.manuscriptId
        || JSON.stringify(saved.queued) !== JSON.stringify(recovery.queued))) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      store.clear(recovery); this.queuedUnsentClearRemoved = true; await store.flush?.();
      if (this.queuedRecovery !== recovery || this.queuedAdmission.getSnapshot().prepareMayHaveDispatched) return false;
      this.queuedSettled(); this.setQueuedRecovery(null); this.queuedAdmission.reset(); return this.dismiss();
    } catch (cause: unknown) {this.queuedIssue(cause); return false;}
  }
  async reconcileQueuedRetirement(action: "check" | "retry" | "begin" = "check"): Promise<"active" | "pending" | "retired"> {
    const original = this.queuedRecovery, retirement = this.retirement, store = this.receiptStore;
    if (!original || !retirement || !store) return "active";
    if (action === "begin" && this.getQueuedAdmission().startMayHaveDispatched && !retirement.hasProof()) return "pending";
    try {
      const result = await retirement.run(original, action);
      if (this.closed || this.queuedRecovery !== original) return "pending";
      if (result !== "retired") return result;
      const state = this.getSnapshot();
      if (state.admission || state.outcome || ["preparing", "starting", "started"].includes(state.phase)) return "pending";
      const saved = store.read(original);
      if (saved && (!isWritingQueuedCompactionRecovery(saved) || saved.inputId !== original.inputId
        || saved.requestId !== original.requestId)) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      if (!saved && !this.queuedUnsentClearRemoved && this.queuedReserved) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      store.clear(original); this.queuedUnsentClearRemoved = true; await store.flush?.();
      if (this.closed || this.queuedRecovery !== original) return "pending";
      if (!(state.preview ? this.retireUnstartedPreview(state.preview) : this.dismiss())) return "pending";
      this.queuedSettled(); this.setQueuedRecovery(null); this.queuedAdmission.reset(); retirement.reset(); this.update({});
      return "retired";
    } catch (cause: unknown) {if (!this.closed && this.queuedRecovery === original) this.queuedIssue(cause); return "pending";}
  }
  async settleQueued(request: AgentWritingQueuedCompactionSettleRequest): Promise<AgentWritingQueuedCompactionSettleResponse> {
    this.settlement = {phase: "settling", request: structuredClone(request), cause: null, result: null}; this.update({});
    try {
      const result = await this.queuedGateway.settleWritingQueued(structuredClone(request));
      if (result.inputId !== request.inputId || result.requestId !== request.requestId || result.outcome !== this.getSnapshot().outcome)
        throw new Error("COMPACTION_QUEUE_CLAIM_MISMATCH");
      this.settlement = {...this.settlement, result}; this.update({}); return result;
    }
    catch (cause: unknown) { this.queuedIssue(cause); throw cause; }
  }
  private readonly queuedGateway: AgentWritingCompactionGateway;
  private readonly manualPreparation: WritingManualCompactionPreparation;
  private checkedHistoryStart: string | null = null;
  private closed = false;
  configureManualPreparation(receipts: WritingCompactionReceiptStore, drafts?: WritingDraftAcknowledgmentPort): void {
    this.receiptStore = receipts; this.manualPreparation.configure(receipts, drafts);
  }
  getManualPreparation = () => this.manualPreparation.getSnapshot();
  getManualAdmission = () => this.manualPreparation.getAdmission();
  checkManualAdmissionBlock = () => this.manualPreparation.checkAdmissionBlock();
  clearManualAdmissionBlock = () => this.manualPreparation.discardAdmissionBlock();
  manualPending = () => this.manualPreparation.unresolved();
  async clearManualPreparation(allowUnstarted = false): Promise<boolean> {return this.manualPreparation.clear(allowUnstarted);}
  async retryManualPreparationLocal(): Promise<void> {
    await this.manualPreparation.retryLocal(); const manual = this.manualPreparation.getSnapshot(), result = manual.recovery?.manual.result;
    if (manual.recovery?.manual.start?.result) {this.installManualAdmission(); return;}
    if (manual.phase === "ready" && result && this.getSnapshot().error === "prepare") this.update({phase: "preview", preview: flatten(result), error: null, cause: undefined});
  }
  async retryManualPreparation(): Promise<void> {
    const manual = this.manualPreparation.getSnapshot();
    if (!manual.recovery || this.getSnapshot().error !== "prepare") return;
    this.update({request: manual.recovery.manual.prepare}); await this.retryPrepare(false);
  }
  resetManualPreparation(): void {this.manualPreparation.reset();}
  override async prepare(value: WritingCompactionRequest, acknowledgment?: () => void, token?: ConversationDraftAcknowledgmentToken | null): Promise<void> {
    if (this.closed || this.getSnapshot().phase !== "idle") return;
    this.manualPreparation.captureDraftAcknowledgment(value.queued ? null : token, value);
    await super.prepare(value, token && !value.queued ? undefined : acknowledgment);
  }
  private installManualAdmission(): void {
    if (this.closed) return;
    const result = this.manualPreparation.getSnapshot().recovery?.manual.start?.result;
    if (result) this.update({phase: "started", admission: result, outcome: this.getSnapshot().outcome ?? result.outcome, error: null, cause: undefined});
  }
  async checkManualStart(): Promise<void> {
    if (this.closed || !this.manualPreparation.hasDraftAcknowledgment()) return;
    const result = await this.manualPreparation.checkStarted();
    if (this.closed) return;
    if (result) this.installManualAdmission();
    else {
      const manual = this.manualPreparation.getSnapshot();
      if (manual.cause || manual.startStatus?.type === "notFound" || manual.startStatus?.type === "unconfirmed")
        this.update({phase: "error", error: "start", cause: manual.cause});
      else if (manual.startStatus?.type === "prepared" && this.getSnapshot().error === "start") this.update({phase: "preview", error: null, cause: undefined});
    }
  }
  override async recover(value: WritingCompactionReceipt): Promise<void> {
    if (value.inputId && !this.queuedRecovery) {this.queuedAdmission.restore(true); this.prepareAttempt.replayUnknown = true;}
    await super.recover(value);
    if (value.inputId && !this.closed) await this.reconcileQueuedRetirement();
    if (!this.closed && this.getSnapshot().preview && this.manualPreparation.hasDraftAcknowledgment()) await this.checkManualStart();
  }
  override async confirm(mode: AgentExecutionMode): Promise<void> {
    if (this.closed) return;
    if (this.queuedRecovery && await this.reconcileQueuedRetirement() !== "active") return;
    const manual = this.manualPreparation.getSnapshot();
    if (manual.recovery?.manual.start?.result) {await this.retryManualPreparationLocal(); return;}
    const current = this.getSnapshot();
    const canConfirm = current.phase === "preview" || current.phase === "error" && current.error === "start";
    const manualStart = !current.preview?.queued && manual.recovery?.requestId === current.preview?.requestId;
    const startMayHaveDispatched = manualStart ? this.getManualAdmission().startMayHaveDispatched : this.getQueuedAdmission().startMayHaveDispatched;
    if (canConfirm) this.startAttempt.replayUnknown = startMayHaveDispatched && (current.error === "start" || manual.priorStartUnknown === true);
    const priorUnknown = manual.priorStartUnknown;
    await super.confirm(mode);
    if (this.getSnapshot().cause instanceof WritingCompactionAdmissionClosed
      || this.manualPreparation.startFailedBeforeDispatch(this.getSnapshot().cause)) {
      if (priorUnknown && this.getSnapshot().error === "startRejected") this.update({error: "start"});
      return;
    }
    if (this.manualPreparation.hasDraftAcknowledgment()) {
      if (this.getSnapshot().error === "start" && this.getManualAdmission().startMayHaveDispatched) this.manualPreparation.observeUnknownStart();
      else if (priorUnknown && this.getSnapshot().error === "startRejected") this.update({error: "start"});
    }
  }

  constructor(scope: WritingCompactionScope, ports: WritingCompactionPorts) {
    let manual: WritingManualCompactionPreparation;
    let queuedAdmission: WritingCompactionAdmission;
    const startAttempt = {replayUnknown: false};
    const prepareAttempt = {replayUnknown: false};
    const conversationId = scope.conversationId.toLowerCase(), manuscriptId = scope.manuscriptId.toLowerCase();
    const check = (receipt: WritingCompactionReceipt): WritingCompactionReceipt => {
      const value = decodeWritingCompactionReceipt(receipt);
      if (value.conversationId !== conversationId || value.manuscriptId !== manuscriptId)
        throw new Error("COMPACTION_PREPARATION_SCOPE_MISMATCH");
      return {...value, ...(receipt.inputId ? {inputId: receipt.inputId} : {})};
    };
    super({
      conversationId,
      decodeRequest(value) {
        check({ conversationId: value.request.conversationId, requestId: value.request.requestId,
          manuscriptId: value.request.context.manuscriptId });
        if (value.request.text.trim() !== "/compact" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)
          throw new Error("COMPACTION_PREPARATION_INVALID");
        return structuredClone(value);
      },
      decodeReceipt(value) {
        const receipt = decodeWritingCompactionReceipt(value);
        const inputId = value && typeof value === "object" && "inputId" in value ? value.inputId : undefined;
        if (inputId !== undefined) return check({...decodeAgentWritingQueuedCompactionReadRequest({...receipt, inputId}), requestId: receipt.requestId});
        return check(receipt);
      },
      receipt(value) { return check({ conversationId: value.request.conversationId, requestId: value.request.requestId,
        manuscriptId: value.request.context.manuscriptId, ...(value.queued ? {inputId: value.queued.inputId} : {}) }); },
    }, {
      prepare: async request => {
        if (!request.queued) return flatten(await manual.prepare(request));
        const value = {...request.queued, submission: request.request, expectedRevision: request.expectedRevision};
        const original = this.queuedRecovery?.queued.prepare;
        const replay = prepareAttempt.replayUnknown && queuedAdmission.getSnapshot().prepareMayHaveDispatched && !!original
          && original.inputId === value.inputId && original.expectedQueueRevision === value.expectedQueueRevision
          && original.previousRequestId === value.previousRequestId && sameAgentWritingCompactionPrepareRequest(
            {request: original.submission, expectedRevision: original.expectedRevision}, {request: value.submission, expectedRevision: value.expectedRevision});
        queuedAdmission.beforeDispatch("prepare", {conversationId: request.request.conversationId,
          manuscriptId: request.request.context.manuscriptId, requestId: request.request.requestId}, replay);
        try {return flattenQueued(await ports.gateway.prepareWritingQueued(value));}
        catch (cause: unknown) {prepareAttempt.replayUnknown = !rejected(cause) && !writingManualPreparationRejection(cause, request); throw cause;}
      },
      restore: async receipt => {
        if (!receipt.inputId) {
          if (manual.restoreLocal(receipt)) return flatten(await manual.check(receipt));
          queuedAdmission.restore(true); return flatten(await ports.gateway.restoreWriting(receipt));
        }
        const value = await ports.gateway.readWritingQueued({...receipt, inputId: receipt.inputId});
        if (!value) throw "notFound";
        if (value.kind !== "compact" || value.requestId !== receipt.requestId) throw new Error("COMPACTION_QUEUE_CLAIM_MISMATCH");
        this.retirement?.observe(value);
        return flattenQueued(value);
      },
      start: async value => {
        const { expectedRevision, queued: _queued, ...preview } = value;
        const request = agentWritingCompactionStartRequest({preview, expectedRevision});
        let response;
        if (!_queued && manual.getSnapshot().recovery?.requestId === preview.requestId) response = await manual.start(request, startAttempt.replayUnknown);
        else {
          queuedAdmission.beforeDispatch("start", {conversationId: preview.conversationId, manuscriptId: preview.manuscriptId,
            requestId: preview.requestId}, startAttempt.replayUnknown);
          response = await ports.gateway.start(request);
        }
        if (response.conversationId !== preview.conversationId || response.requestId !== preview.requestId || response.turnId !== preview.turnId)
          throw new Error("COMPACTION_ADMISSION_IDENTITY_MISMATCH");
        return response;
      },
    }, ports.turns, { isStartRejected: cause => rejected(cause) || manual.startFailedBeforeDispatch(cause) });
    const changed = () => this.update({});
    this.queuedAdmission = queuedAdmission = new WritingCompactionAdmission(ports.isAdmissionDisabled ?? (() => false), changed);
    this.startAttempt = startAttempt; this.prepareAttempt = prepareAttempt;
    this.manualPreparation = manual = new WritingManualCompactionPreparation(ports.gateway, changed, ports.isAdmissionDisabled);
    if (ports.receipts) this.manualPreparation.configure(ports.receipts, ports.draftAcknowledgments);
    this.queuedGateway = ports.gateway;
    this.retirement = ports.cancellation ? new WritingQueuedCompactionRetirement(ports.gateway, ports.cancellation,
      original => !this.closed && this.queuedRecovery === original, changed) : null;
    this.receiptStore = ports.receipts;
    this.history = new AgentConversationController(ports.history, ports.projection);
    this.detachHistory = this.history.subscribe(() => {
      const history = this.history.getSnapshot();
      if (history.status !== "ready") return;
      const state = this.getSnapshot(), turnId = state.preview?.turnId;
      const turn = turnId ? history.projection?.turns.get(turnId) : undefined;
      if (!turnId || turn?.taskKind !== "compact") return;
      if (this.manualPreparation.hasDraftAcknowledgment() && this.checkedHistoryStart !== turnId) {
        this.checkedHistoryStart = turnId; void this.checkManualStart();
      }
      this.observeStarted(turnId);
      if (turn.outcome && this.getSnapshot().outcome !== turn.outcome) this.observeOutcome(turnId, turn.outcome);
    });
    this.detachReview = this.subscribe(() => this.watch());
  }

  private watch(): void {
    if (this.retirement?.hasProof()) {if (this.watching) {this.watching = false; this.history.pause();} return;}
    const state = this.getSnapshot();
    const queued = state.preview?.queued;
    if (queued?.outcome && state.outcome !== queued.outcome) {
      if (state.phase === "preview") this.observeStarted(queued.preview.turnId);
      else this.observeOutcome(queued.preview.turnId, queued.outcome);
      return;
    }
    const needsHistory = !!state.preview && !state.outcome
      && (state.phase === "starting" || state.phase === "started"
        || (state.phase === "preview" && state.recoveryReceipt !== null)
        || (state.phase === "error" && state.error === "start"));
    if (needsHistory && state.preview && !this.watching) {
      this.watching = true;
      void this.history.open(state.preview.conversationId);
    } else if (!needsHistory && this.watching) {
      this.watching = false;
      this.history.pause();
    }
  }

  override dispose(): void {
    this.closed = true; this.manualPreparation.dispose(); this.detachReview(); this.detachHistory(); this.history.dispose(); super.dispose();
  }
}

const owners = new ReviewedSubmissionOwnerRegistry<WritingCompactionController>(controller => {
  const state = controller.getSnapshot();
  return (state.phase !== "idle" && state.outcome === null) || controller.queuedPending() || controller.manualPending();
});
export function hasPendingWritingCompactions(): boolean { return owners.hasPending(); }
export function acquireWritingCompactionOwner(scope: WritingCompactionScope, ports: WritingCompactionPorts) {
  return owners.acquire(JSON.stringify([scope.identity, scope.manuscriptId.toLowerCase(), scope.conversationId.toLowerCase()]),
    () => new WritingCompactionController(scope, ports));
}
export function resetWritingCompactionOwnersForTests(): void { owners.resetForTests(); }

/** Retain an owner lease while awaiting this result, independently of a view. */
export function waitForWritingCompaction(controller: WritingCompactionController): Promise<boolean> {
  return new Promise(resolve => {
    let detach = () => {};
    const check = (): void => {
      const state = controller.getSnapshot();
      if (state.outcome !== null || state.phase === "error") {
        detach(); resolve(state.outcome === "completed");
      }
    };
    detach = controller.subscribe(check); check();
  });
}
