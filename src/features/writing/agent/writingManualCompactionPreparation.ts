import {decodeAgentWritingCompactionPrepareRequest, decodeAgentWritingCompactionPreview, decodeAgentWritingPrepareResult,
  decodeAgentWritingCompactionPrepareStatusResponse, sameAgentWritingCompactionPrepareRequest,
  decodeAgentWritingCompactionStartStatusResponse, sameAgentCompactionStartRequest, decodeAgentCompactionStartRequest, decodeAgentStartResponse, agentWritingCompactionStartRequest,
  type AgentCompactionStartRequest, type AgentStartResponse, type AgentWritingCompactionStartStatusResponse,
  type AgentWritingCompactionPrepareRequest, type AgentWritingCompactionPreview, type AgentWritingCompactionPrepareStatusResponse, type AgentWritingReceipt} from "@research-assistant/core/agent";
import type {AgentWritingCompactionGateway} from "@research-assistant/data/agent";
import type {WritingCompactionReceiptStore} from "./writingCompactionReceipt";
import {decodeWritingManualCompactionRecovery, isWritingManualCompactionRecovery, writingManualPreparationRejection, type WritingManualCompactionRecovery} from "./writingManualCompactionRecovery";
import {decodeWritingDraftAcknowledgment, type WritingDraftAcknowledgmentPort} from "@research-assistant/workbench-sdk/agent-writing";
import type { ConversationDraftAcknowledgmentToken } from "@research-assistant/workbench-sdk/agent-drafts";
import {WritingCompactionAdmission} from "./writingCompactionAdmission";
export interface WritingManualCompactionPreparationSnapshot {
  readonly phase: "idle" | "saving" | "sending" | "unknown" | "checking" | "notFound" | "unconfirmed" | "rejected" | "ready" | "clearing" | "localError" | "done";
  readonly recovery: WritingManualCompactionRecovery | null;
  readonly status: AgentWritingCompactionPrepareStatusResponse["status"] | null;
  readonly priorUnknown: boolean;
  readonly recovered: boolean;
  readonly cause: unknown;
  readonly startStatus?: AgentWritingCompactionStartStatusResponse["status"] | null;
  readonly priorStartUnknown?: boolean;
}
const initial = (): WritingManualCompactionPreparationSnapshot => ({phase: "idle", recovery: null, status: null, priorUnknown: false, recovered: false, cause: null});
/** Preparation I/O and its existing receipt, inside the compact task owner.
 * It never chooses a new R/W or starts a compact task. */
export class WritingManualCompactionPreparation {
  private state = initial();
  private store: WritingCompactionReceiptStore | null = null;
  private disposed = false;
  private clearing = false;
  private clearRemoved = false;
  private reserved = false;
  private pending: Promise<AgentWritingCompactionPreview> | null = null;
  private drafts: WritingDraftAcknowledgmentPort | undefined;
  private captured: ConversationDraftAcknowledgmentToken | null = null;
  private finishPending: Promise<void> | null = null;
  private checkPending: Promise<AgentStartResponse | null> | null = null;
  private draftConsumed = false;
  private readonly admission: WritingCompactionAdmission;
  // A local save failure is not an ambiguous Native start. Keep its identity
  // only for the current adapter call, outside the persisted recovery format.
  private localStartFailure: {readonly cause: unknown} | null = null;
  constructor(private readonly gateway: AgentWritingCompactionGateway, private readonly changed: () => void, isAdmissionDisabled: () => boolean = () => false) {
    this.admission = new WritingCompactionAdmission(isAdmissionDisabled, changed);
  }
  getAdmission = () => this.admission.getSnapshot();
  startFailedBeforeDispatch = (cause: unknown): boolean => this.localStartFailure !== null && this.localStartFailure.cause === cause;
  configure(store: WritingCompactionReceiptStore, drafts?: WritingDraftAcknowledgmentPort): void {this.store = store; if (drafts) this.drafts = drafts;}
  captureDraftAcknowledgment(token: ConversationDraftAcknowledgmentToken | null | undefined, request: AgentWritingCompactionPrepareRequest): void {
    this.captured = decodeWritingDraftAcknowledgment(token, {conversationId: request.request.conversationId, manuscriptId: request.request.context.manuscriptId});
  }
  hasDraftAcknowledgment = (): boolean => !!this.state.recovery?.manual.draftAcknowledgment;
  observeUnknownStart(): void {this.update({priorStartUnknown: true});}
  getSnapshot = () => this.state;
  unresolved = () => this.state.phase !== "idle" && this.state.phase !== "done";
  private update(patch: Partial<WritingManualCompactionPreparationSnapshot>): void {if (!this.disposed) {this.state = {...this.state, ...patch}; this.changed();}}
  private receipts(): WritingCompactionReceiptStore {if (!this.store) throw new Error("COMPACTION_RECOVERY_PERSISTENCE_FAILED"); return this.store;}
  private current(): WritingManualCompactionRecovery {
    const value = this.state.recovery; if (!value) throw new Error("COMPACTION_RECOVERY_RECEIPT_INVALID"); return value;
  }
  private sameOperation(value: WritingManualCompactionRecovery): boolean {
    const current = this.state.recovery;
    return !this.disposed && !!current && sameAgentWritingCompactionPrepareRequest(current.manual.prepare, value.manual.prepare)
      && JSON.stringify(current.manual.draftAcknowledgment) === JSON.stringify(value.manual.draftAcknowledgment);
  }
  private async persist(flushDraft = false): Promise<void> {
    const value = this.current(); if (this.disposed) throw new Error("COMPACTION_RECOVERY_OWNER_DISPOSED");
    const store = this.receipts(), saved = store.read(value);
    if (this.reserved && !saved || saved && (!isWritingManualCompactionRecovery(saved) || !sameAgentWritingCompactionPrepareRequest(saved.manual.prepare, value.manual.prepare)))
      throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
    store.save(value); this.reserved = true;
    if (flushDraft && value.manual.draftAcknowledgment) {
      if (!this.drafts) throw new Error("COMPACTION_DRAFT_ACKNOWLEDGMENT_UNAVAILABLE"); await this.drafts.flush();
      if (this.disposed) throw new Error("COMPACTION_RECOVERY_OWNER_DISPOSED");
    }
    await store.flush?.();
  }
  private load(receipt: AgentWritingReceipt): boolean {
    const saved = this.receipts().read(receipt);
    if (!saved || !isWritingManualCompactionRecovery(saved)) return false;
    if (saved.requestId !== receipt.requestId) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
    const recovery = decodeWritingManualCompactionRecovery(saved);
    this.reserved = true;
    if (this.state.recovery && !sameAgentWritingCompactionPrepareRequest(this.state.recovery.manual.prepare, recovery.manual.prepare)) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
    if (!this.state.recovery) {
      this.admission.restore(true);
      this.update({phase: "unknown", recovery, recovered: true, priorUnknown: !recovery.manual.knownRejected,
        cause: recovery.manual.rejection, priorStartUnknown: !!recovery.manual.start && !recovery.manual.start.result});
    }
    return true;
  }
  restoreLocal(receipt: AgentWritingReceipt): boolean {return !this.disposed && this.load(receipt);}
  private result(value: unknown): AgentWritingCompactionPreview {
    const result = decodeAgentWritingCompactionPreview(value), intent = this.current().manual.prepare;
    decodeAgentWritingPrepareResult(result.preview, intent.request);
    if (result.expectedRevision !== intent.expectedRevision) throw new Error("COMPACTION_PREPARATION_SCOPE_MISMATCH");
    return result;
  }
  private async committed(value: unknown): Promise<AgentWritingCompactionPreview> {
    const result = this.result(value), current = this.current();
    if (this.disposed) throw new Error("COMPACTION_RECOVERY_OWNER_DISPOSED");
    this.update({recovery: {...current, manual: {...current.manual, result, knownRejected: false, rejection: null}}, cause: null});
    try {await this.persist(); if (this.disposed) throw new Error("COMPACTION_RECOVERY_OWNER_DISPOSED"); this.update({phase: "ready"}); return result;}
    catch (cause: unknown) {this.update({phase: "localError", cause}); throw cause;}
  }
  private async inspect(): Promise<AgentWritingCompactionPreview | null> {
    const current = this.current();
    if (current.manual.result) return this.committed(current.manual.result);
    const rejection = current.manual.rejection;
    this.update({phase: "checking", recovered: true, cause: null});
    try {
      const response = decodeAgentWritingCompactionPrepareStatusResponse(await this.gateway.prepareWritingStatus(structuredClone(current.manual.prepare)));
      if (!sameAgentWritingCompactionPrepareRequest(response.intent, current.manual.prepare)) throw new Error("COMPACTION_PREPARATION_SCOPE_MISMATCH");
      if (this.disposed) throw new Error("COMPACTION_RECOVERY_OWNER_DISPOSED"); this.update({status: response.status});
      if (response.status.type === "committed") return this.committed(response.status.result);
      this.update({phase: response.status.type, cause: current.manual.knownRejected ? rejection : null}); return null;
    } catch (cause: unknown) {this.update({phase: this.state.recovery?.manual.result ? "localError" : "unknown", cause}); throw cause;}
  }
  private async send(): Promise<AgentWritingCompactionPreview> {
    const current = this.current(); this.update({phase: "saving", cause: null});
    try {await this.persist(true);} catch (cause: unknown) {this.admission.failedBeforeDispatch("prepare"); this.update({phase: "localError", cause}); throw cause;}
    if (this.disposed) throw new Error("COMPACTION_RECOVERY_OWNER_DISPOSED");
    const request = structuredClone(current.manual.prepare);
    this.update({phase: "sending"});
    try {this.admission.beforeDispatch("prepare", current, this.state.priorUnknown && this.admission.getSnapshot().prepareMayHaveDispatched);}
    catch (cause: unknown) {this.update({phase: "localError", cause}); throw cause;}
    try {return await this.committed(await this.gateway.prepareWriting(request));}
    catch (cause: unknown) {
      if (this.disposed || this.state.recovery?.manual.result) throw cause;
      const code = !this.state.priorUnknown ? writingManualPreparationRejection(cause, current.manual.prepare) : null;
      this.update({phase: code ? "rejected" : "unknown", priorUnknown: code === null, cause,
        recovery: {...current, manual: {...current.manual, knownRejected: code !== null, rejection: code}}});
      if (code) try {await this.persist();} catch (local: unknown) {this.update({phase: "localError", cause: local}); throw local;}
      throw cause;
    }
  }
  prepare(value: AgentWritingCompactionPrepareRequest, token = this.captured): Promise<AgentWritingCompactionPreview> {
    const prepare = decodeAgentWritingCompactionPrepareRequest(value);
    const acknowledgment = decodeWritingDraftAcknowledgment(token, {conversationId: prepare.request.conversationId, manuscriptId: prepare.request.context.manuscriptId});
    if (this.pending) return this.state.recovery && sameAgentWritingCompactionPrepareRequest(this.state.recovery.manual.prepare, prepare)
      && (!acknowledgment || JSON.stringify(acknowledgment) === JSON.stringify(this.state.recovery.manual.draftAcknowledgment))
      ? this.pending : Promise.reject(new Error("COMPACTION_RECOVERY_RECEIPT_PENDING"));
    const work = (async () => {
      const receipt = {conversationId: prepare.request.conversationId, requestId: prepare.request.requestId, manuscriptId: prepare.request.context.manuscriptId};
      const existing = this.receipts().read(receipt);
      if (existing && !isWritingManualCompactionRecovery(existing)) throw new Error("COMPACTION_RECOVERY_FULL_INTENT_MISSING");
      if (existing) {
        this.load(receipt); if (!sameAgentWritingCompactionPrepareRequest(this.current().manual.prepare, prepare)) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
        if (acknowledgment && JSON.stringify(acknowledgment) !== JSON.stringify(this.current().manual.draftAcknowledgment)) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
        const result = await this.inspect(); if (result) return result;
      } else {
        if (this.state.recovery && (this.reserved || !sameAgentWritingCompactionPrepareRequest(this.state.recovery.manual.prepare, prepare))) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
        if (!this.state.recovery) this.update({...initial(), phase: "saving", recovery: {...receipt, manual: {prepare, result: null, knownRejected: false, rejection: null, draftAcknowledgment: acknowledgment, start: null}}});
      }
      return this.send();
    })();
    this.pending = work; const release = () => {if (this.pending === work) this.pending = null;}; void work.then(release, release); return work;
  }
  async check(receipt: AgentWritingReceipt): Promise<AgentWritingCompactionPreview> {
    if (!this.state.recovery && !this.load(receipt)) throw new Error("COMPACTION_RECOVERY_FULL_INTENT_MISSING");
    const current = this.current();
    if (current.conversationId !== receipt.conversationId || current.manuscriptId !== receipt.manuscriptId || current.requestId !== receipt.requestId)
      throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
    const result = await this.inspect(); if (result) return result;
    throw this.state.status?.type === "unconfirmed" ? {code: "COMPACTION_PREPARE_UNCONFIRMED", detail: this.state.status.detail} : "notFound";
  }
  private started(value: unknown): AgentStartResponse {
    const result = decodeAgentStartResponse(value), preview = this.current().manual.result?.preview;
    if (!preview || result.conversationId !== preview.conversationId || result.requestId !== preview.requestId || result.turnId !== preview.turnId)
      throw new Error("COMPACTION_ADMISSION_IDENTITY_MISMATCH");
    return result;
  }
  private async finishKnown(): Promise<void> {
    if (this.finishPending) return this.finishPending;
    const work = (async () => {
      if (this.disposed || this.state.phase === "done") return;
      const current = this.current(); if (!current.manual.start?.result || !current.manual.draftAcknowledgment) return;
      try {
        if (this.clearRemoved) {await this.clear(); return;}
        await this.persist(); if (!this.sameOperation(current)) return;
        if (!this.draftConsumed) {
          if (!this.drafts) throw new Error("COMPACTION_DRAFT_ACKNOWLEDGMENT_UNAVAILABLE");
          await this.drafts.consume(current.manual.draftAcknowledgment, current); if (!this.sameOperation(current)) return;
          this.draftConsumed = true;
        }
        await this.clear();
      } catch (cause: unknown) {this.update({phase: "localError", cause});}
    })();
    this.finishPending = work; try {await work;} finally {if (this.finishPending === work) this.finishPending = null;}
  }
  private async recordStarted(request: AgentCompactionStartRequest, value: unknown): Promise<AgentStartResponse> {
    const response = this.started(value), current = this.current();
    if (this.disposed) return response;
    this.admission.restore(true);
    if (!current.manual.start?.result) this.update({recovery: {...current, manual: {...current.manual, start: {request, result: response}}}, cause: null});
    await this.finishKnown(); return this.current().manual.start?.result ?? response;
  }
  async start(value: AgentCompactionStartRequest, replayUnknown = false): Promise<AgentStartResponse> {
    this.localStartFailure = null;
    const request = decodeAgentCompactionStartRequest(value), current = this.current(), preview = current.manual.result;
    if (!preview || !sameAgentCompactionStartRequest(request, agentWritingCompactionStartRequest(preview))) throw new Error("COMPACTION_PREPARATION_SCOPE_MISMATCH");
    if (!current.manual.draftAcknowledgment) {
      try {this.admission.beforeDispatch("start", current, replayUnknown);}
      catch (cause: unknown) {this.localStartFailure = {cause}; this.update({phase: "localError", cause}); throw cause;}
      return this.started(await this.gateway.start(request));
    }
    if (current.manual.start?.result) {await this.finishKnown(); return current.manual.start.result;}
    this.update({recovery: {...current, manual: {...current.manual, start: {request, result: null}}}, cause: null});
    try {await this.persist(true);} catch (cause: unknown) {
      this.localStartFailure = {cause}; this.admission.failedBeforeDispatch("start"); this.update({phase: "localError", cause}); throw cause;
    }
    if (this.disposed) throw new Error("COMPACTION_RECOVERY_OWNER_DISPOSED");
    const dispatched = structuredClone(request);
    try {this.admission.beforeDispatch("start", current, replayUnknown || this.state.priorStartUnknown === true);}
    catch (cause: unknown) {this.localStartFailure = {cause}; this.update({phase: "localError", cause}); throw cause;}
    return this.recordStarted(request, await this.gateway.start(dispatched));
  }
  async checkStarted(checkBlocked = false): Promise<AgentStartResponse | null> {
    if (this.checkPending) return this.checkPending;
    const work = (async () => {
      const current = this.current();
      if ((!current.manual.draftAcknowledgment && !(checkBlocked && this.admission.getSnapshot().blockedBeforeDispatch === "start"))
        || !current.manual.result || this.disposed) return null;
      if (current.manual.start?.result) {await this.finishKnown(); return current.manual.start.result;}
      const request = current.manual.start?.request ?? agentWritingCompactionStartRequest(current.manual.result);
      try {
        const response = decodeAgentWritingCompactionStartStatusResponse(await this.gateway.startStatus(structuredClone(request)));
        if (!sameAgentCompactionStartRequest(response.intent, request)) throw new Error("COMPACTION_PREPARATION_SCOPE_MISMATCH");
        if (!this.sameOperation(current)) return null;
        const known = this.current().manual.start?.result;
        if (known) {await this.finishKnown(); return known;}
        this.update({startStatus: response.status, cause: null});
        if (response.status.type === "started") return this.recordStarted(request, response.status.result);
        if (response.status.type === "prepared" && response.status.preview.turnId !== current.manual.result.preview.turnId) throw new Error("COMPACTION_ADMISSION_IDENTITY_MISMATCH");
        if (response.status.type !== "prepared") this.update({cause: {code: "COMPACTION_START_UNCONFIRMED", ...(response.status.type === "unconfirmed" ? {detail: response.status.detail} : {})}});
        return null;
      } catch (cause: unknown) {
        if (!this.sameOperation(current)) return null;
        const known = this.current().manual.start?.result;
        if (known) return known;
        this.update({cause}); return null;
      }
    })();
    this.checkPending = work; try {return await work;} finally {if (this.checkPending === work) this.checkPending = null;}
  }
  async clear(allowUnstarted = false): Promise<boolean> {
    if (this.disposed || !this.state.recovery) return false; if (this.clearing) return false;
    if (this.hasDraftAcknowledgment() && this.current().manual.start && !this.draftConsumed && !this.clearRemoved
      && !(allowUnstarted && !this.current().manual.start?.result && !this.state.priorStartUnknown)) return false;
    this.clearing = true; this.update({phase: "clearing", cause: null});
    try {
      const value = this.current(), store = this.receipts(), saved = store.read(value);
      if ((!saved && !this.clearRemoved) || saved && (!isWritingManualCompactionRecovery(saved)
        || !sameAgentWritingCompactionPrepareRequest(saved.manual.prepare, value.manual.prepare)
        || JSON.stringify(saved.manual.draftAcknowledgment) !== JSON.stringify(value.manual.draftAcknowledgment)
        || saved.manual.start && (!value.manual.start || !sameAgentCompactionStartRequest(saved.manual.start.request, value.manual.start.request))))
        throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      store.clear(value); this.clearRemoved = true; await store.flush?.(); if (!this.sameOperation(value)) return false;
      this.update({phase: "done"}); return true;
    } catch (cause: unknown) {this.update({phase: "localError", cause}); return false;}
    finally {this.clearing = false;}
  }
  async checkAdmissionBlock(): Promise<void> {
    const blocked = this.admission.getSnapshot().blockedBeforeDispatch;
    if (blocked === "prepare") await this.inspect();
    else if (blocked === "start") await this.checkStarted(true);
  }
  async discardAdmissionBlock(): Promise<boolean> {
    const observed = this.admission.getSnapshot(), recovery = this.state.recovery;
    if (!recovery) return false;
    const prepare = observed.blockedBeforeDispatch === "prepare" && !observed.prepareMayHaveDispatched
      && !this.state.priorUnknown && this.state.status?.type === "notFound";
    const start = observed.blockedBeforeDispatch === "start" && !observed.startMayHaveDispatched
      && !this.state.priorStartUnknown && !recovery.manual.start?.result && this.state.startStatus?.type === "prepared";
    return (prepare || start) && await this.clear(true);
  }
  async retryLocal(): Promise<void> {
    await this.receipts().retry?.(); if (this.disposed) return;
    if (this.clearRemoved) {await this.clear(); return;}
    if (this.current().manual.start?.result) {if (!this.draftConsumed) await this.drafts?.retry(); if (!this.disposed) await this.finishKnown(); return;}
    const result = this.current().manual.result; if (result) await this.committed(result);
  }
  reset(): void {this.state = initial(); this.clearRemoved = false; this.reserved = false; this.captured = null; this.draftConsumed = false; this.localStartFailure = null; this.admission.reset();}
  dispose(): void {this.disposed = true;}
}
