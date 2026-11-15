import { useEffect, useMemo, useRef, useState } from "react";
import { executionModeForModel, decodeAgentWritingQueuedCompactionPrepareRequest, type AgentWritingCompactionPrepareRequest, type AgentWritingReceipt,
  type AgentWritingQueuedCompactionPrepareRequest } from "@research-assistant/core/agent";
import type { AgentInputQueueGateway, AgentInputQueuePreviewGateway, AgentSubmissionGateway } from "@research-assistant/data/agent";
import { agentInputQueueGateway, agentInputQueuePreviewGateway, agentSubmissionGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { getAppStorage } from "@research-assistant/workbench-sdk/storage";
import {
  acquireWritingCompactionOwner, waitForWritingCompaction, type WritingCompactionController,
  type WritingCompactionPorts, type WritingCompactionScope, type WritingCompactionSnapshot,
} from "./writingCompactionController";
import { createWritingCompactionReceiptStore, type WritingCompactionReceiptStore } from "./writingCompactionReceipt";
import type { AgentConversationSnapshot } from "@research-assistant/workbench-sdk/agent-conversations";
import { persistQueuedCompaction, queuedCompactionRecovery, queuedCompactionRequest, settleQueuedCompaction } from "./writingQueuedCompactionActions";
import { isWritingQueuedCompactionRecovery } from "./writingQueuedCompactionRecovery";
import {isWritingManualCompactionRecovery} from "./writingManualCompactionRecovery";
import type {WritingManualCompactionPreparationSnapshot} from "./writingManualCompactionPreparation";
import type { ConversationDraftAcknowledgmentToken } from "@research-assistant/workbench-sdk/agent-drafts";
import {useWritingRuntimeAdmission} from "../persistence/writingRuntimeAdmission";
import {WritingCompactionAdmissionClosed} from "./writingCompactionAdmission";
import {writingQueueCancellationRecovery} from "@research-assistant/workbench-sdk/agent-writing";

interface Options extends WritingCompactionPorts {
  readonly scope: WritingCompactionScope | null;
  readonly receipts?: WritingCompactionReceiptStore;
  readonly queue?: Pick<AgentInputQueueGateway, "read">;
  readonly submission?: AgentSubmissionGateway;
  readonly queuePreview?: AgentInputQueuePreviewGateway;
  readonly submissionOwnerKey?: string;
}
interface Owned {
  readonly key: string;
  readonly state: WritingCompactionSnapshot;
  readonly history: AgentConversationSnapshot;
  readonly manual: WritingManualCompactionPreparationSnapshot;
  readonly recovery: AgentWritingReceipt | null;
  readonly cancellation: ReturnType<WritingCompactionController["getQueuedCancellation"]>;
  readonly retired: boolean;
}
function receipt(state: WritingCompactionSnapshot): AgentWritingReceipt | null {
  if (state.preview) return { conversationId: state.preview.conversationId, requestId: state.preview.requestId, manuscriptId: state.preview.manuscriptId };
  if (state.request) return { conversationId: state.request.request.conversationId, requestId: state.request.request.requestId, manuscriptId: state.request.request.context.manuscriptId };
  return state.recoveryReceipt;
}
function canStart(controller: WritingCompactionController): boolean {
  const state = controller.getSnapshot();
  return state.phase === "preview" || (state.phase === "error" && state.error === "start");
}

/** The registry and native history own admitted work. The local recovery
 * envelope never translates an unmount into an interrupt or a new execution. */
export function useWritingCompaction(options: Options) {
  const admission = useWritingRuntimeAdmission();
  const { scope, gateway, turns, history, projection } = options;
  const queueGateway = options.queue ?? agentInputQueueGateway;
  const submissionGateway = options.submission ?? agentSubmissionGateway;
  const queuePreviewGateway = options.queuePreview ?? agentInputQueuePreviewGateway;
  const key = scope ? JSON.stringify([scope.identity, scope.manuscriptId, scope.conversationId]) : "none";
  const receipts = useMemo(() => options.receipts ?? createWritingCompactionReceiptStore(getAppStorage()), [options.receipts]);
  const owner = useRef<WritingCompactionController | null>(null);
  const [owned, setOwned] = useState<Owned | null>(null);
  const [issue, setIssue] = useState<{ key: string; cause: unknown } | null>(null);
  const restored = useRef(false);
  function ports(value: WritingCompactionScope): WritingCompactionPorts {
    return {gateway, turns, history, isAdmissionDisabled: admission.isDisabled, ...(projection ? {projection} : {}),
      cancellation: options.cancellation ?? {ownerKey: options.submissionOwnerKey ?? JSON.stringify([value.identity, value.manuscriptId, value.conversationId]),
        submission: submissionGateway, turns, preview: queuePreviewGateway, recovery: writingQueueCancellationRecovery(value),
        queue: queueGateway, isAdmissionDisabled: admission.isDisabled}};
  }

  useEffect(() => {
    if (!scope) { owner.current = null; setOwned(null); return; }
    const lease = acquireWritingCompactionOwner(scope, ports(scope));
    const controller = lease.controller;
    controller.configureManualPreparation(receipts, options.draftAcknowledgments);
    owner.current = controller; restored.current = false;
    let active = true;
    const sync = (): void => {
      const state = controller.getSnapshot();
      if (active) setOwned({key, state, history: controller.history.getSnapshot(), manual: controller.getManualPreparation(),
        cancellation: controller.getQueuedCancellation(),
        retired: controller.hasQueuedRetirementProof(),
        recovery: receipt(state) ?? controller.getQueuedRecovery() ?? controller.getManualPreparation().recovery});
      const saved = receipt(state);
      if (state.outcome && saved && !controller.queuedPending()) {
        if (controller.getManualPreparation().recovery) {
          if (controller.getManualPreparation().recovery?.manual.draftAcknowledgment) return;
          if (controller.getManualPreparation().phase === "ready") void controller.clearManualPreparation();
          return;
        }
        try { receipts.clear(saved); }
        catch (cause: unknown) { if (active) setIssue({ key, cause }); }
      }
    };
    const detach = controller.subscribe(sync), detachHistory = controller.history.subscribe(sync);
    sync();
    try {
      const saved = receipts.read(scope);
      if (saved && controller.getSnapshot().phase === "idle") {
        restored.current = true;
        if (isWritingQueuedCompactionRecovery(saved)) controller.setQueuedRecovery(saved, true);
        void controller.recover(saved).catch((cause: unknown) => { if (active) setIssue({ key, cause }); });
      }
    } catch (cause: unknown) { setIssue({ key, cause }); }
    return () => {
      active = false; detach(); detachHistory(); lease.release();
      if (owner.current === controller) owner.current = null;
    };
    // A new source delta is not a new owner; the controller reads its own tail.
  }, [key, gateway, turns, history, receipts, options.draftAcknowledgments, submissionGateway, queuePreviewGateway, options.submissionOwnerKey]);

  function retain() {
    const held = scope ? acquireWritingCompactionOwner(scope, ports(scope)) : null;
    held?.controller.configureManualPreparation(receipts, options.draftAcknowledgments); return held;
  }
  function retainOriginal() {
    const attached = owner.current, original = owned?.key === key ? owned.recovery : null;
    if (!attached || !original) return null;
    const held = retain(), current = held ? receipt(held.controller.getSnapshot()) ?? held.controller.getQueuedRecovery() ?? held.controller.getManualPreparation().recovery : null;
    if (!held || held.controller !== attached || current?.conversationId !== original.conversationId || current.requestId !== original.requestId
      || current.manuscriptId !== original.manuscriptId) {held?.release(); return null;}
    return held;
  }
  async function confirm(controller: WritingCompactionController): Promise<boolean> {
    const state = controller.getSnapshot();
    const preview = state.preview;
    if (!preview) return false;
    const mode = executionModeForModel(preview.input.model, preview.input.reasoningEffort);
    if (mode === null) throw new Error("COMPACTION_MODEL_UNSUPPORTED");
    // A durable terminal can precede a lost start reply. Keep the exact start
    // attempt running, but do not let its transport ACK own terminal waiting.
    const starting = controller.confirm(mode);
    await Promise.race([starting, waitForWritingCompaction(controller)]);
    if (["idle", "preview"].includes(controller.getSnapshot().phase)) return false;
    return waitForWritingCompaction(controller);
  }
  async function execute(request: AgentWritingCompactionPrepareRequest, acknowledgment?: () => void, token?: ConversationDraftAcknowledgmentToken | null): Promise<boolean> {
    if (admission.isDisabled()) return false;
    const held = retain();
    if (!held) return false;
    const controller = held.controller;
    try {
      const current = controller.getSnapshot();
      if (current.outcome) {
        if (controller.getManualPreparation().recovery) {if (!await controller.clearManualPreparation()) return false; controller.resetManualPreparation();}
        else {const saved = receipt(current); if (saved) receipts.clear(saved);}
        controller.dismiss();
      }
      if (controller.getSnapshot().phase !== "idle") return false;
      if (admission.isDisabled()) return false;
      restored.current = false; setIssue(null);
      await controller.prepare(request, acknowledgment, token);
      return canStart(controller) ? await confirm(controller) : false;
    } catch (cause: unknown) { setIssue({ key, cause }); return false; }
    finally { held.release(); }
  }
  async function finishQueued(controller: WritingCompactionController): Promise<boolean> {
    if (!scope) return false;
    return settleQueuedCompaction(controller, receipts, queueGateway, scope);
  }
  async function executeQueued(value: AgentWritingQueuedCompactionPrepareRequest): Promise<boolean> {
    if (admission.isDisabled()) return false;
    const held = retain(); if (!held) return false;
    const controller = held.controller;
    try {
      if (controller.queuedPending()) return false;
      if (controller.manualPending()) return false;
      if (controller.getSnapshot().phase !== "idle" && !controller.dismiss()) return false;
      const request = decodeAgentWritingQueuedCompactionPrepareRequest(value), recovery = queuedCompactionRecovery(request);
      if (!(await persistQueuedCompaction(controller, receipts, recovery))) return false;
      restored.current = false; setIssue(null);
      await controller.prepare(queuedCompactionRequest(request));
      if (canStart(controller)) await confirm(controller);
      return await finishQueued(controller);
    } catch (cause: unknown) { controller.queuedIssue(cause); return false; }
    finally { held.release(); }
  }
  async function recoverQueued(inputId: string, requestId: string, continueOriginal = false): Promise<boolean> {
    const held = retain(); if (!held || !scope) { held?.release(); return false; }
    const controller = held.controller;
    try {
      const known = controller.getQueuedRecovery();
      if (known && (known.inputId !== inputId || known.requestId !== requestId)) return false;
      if (controller.getSnapshot().phase !== "idle" && !controller.queuedPending() && !controller.dismiss()) return false;
      const existing = receipts.read(scope);
      const recovery = existing && isWritingQueuedCompactionRecovery(existing) ? existing : {conversationId: scope.conversationId, manuscriptId: scope.manuscriptId,
        requestId, inputId, queued: {prepare: null, settle: null}};
      if (recovery.inputId !== inputId || recovery.requestId !== requestId) return false;
      if (!known) controller.setQueuedRecovery(recovery, true);
      if (!(await persistQueuedCompaction(controller, receipts, recovery))) return false;
      restored.current = true;
      if (controller.getSnapshot().phase === "idle") await controller.recover(recovery);
      if (!controller.queuedPending()) return false;
      if (continueOriginal) {
        if (canStart(controller) && !controller.getSnapshot().outcome) await confirm(controller);
        return await finishQueued(controller);
      }
      return false;
    } catch (cause: unknown) { controller.queuedIssue(cause); return false; }
    finally { held.release(); }
  }
  async function recoverExisting(value: AgentWritingReceipt): Promise<boolean | "notFound"> {
    const held = retain(); if (!held) return false;
    try {
      const prior = held.controller.getSnapshot();
      if (prior.outcome) {
        const saved = receipt(prior); if (saved) receipts.clear(saved);
        held.controller.dismiss();
      }
      const existing = receipts.read(value);
      const discoveryOnly = existing === null;
      if (!existing || !isWritingManualCompactionRecovery(existing)) receipts.save(value);
      else if (existing.requestId !== value.requestId) throw new Error("COMPACTION_RECOVERY_RECEIPT_PENDING");
      restored.current = true;
      if (held.controller.getSnapshot().phase === "idle") await held.controller.recover(value);
      const state = held.controller.getSnapshot();
      // This exact native response establishes missing preparation, not a
      // missing task guessed from transport failure or a different watermark.
      if (state.error === "prepare" && state.cause === "notFound") {
        if (!discoveryOnly) return false;
        // This locator was created only for the read above. No prepare was
        // dispatched under it; an older persisted v1 intent stays unresolved.
        receipts.clear(value); await receipts.flush?.(); held.controller.dismiss(); restored.current = false; return "notFound";
      }
      return canStart(held.controller) ? await confirm(held.controller) : false;
    } catch (cause: unknown) { setIssue({ key, cause }); return false; }
    finally { held.release(); }
  }
  async function retry(): Promise<boolean> {
    const held = retainOriginal(); if (!held) return false;
    try {
      const controller = held.controller;
      let current = controller.getSnapshot(), queued = controller.getQueuedRecovery(), manual = controller.getManualPreparation();
      if (queued) {
        if (await controller.reconcileQueuedRetirement("retry") !== "active") return false;
        current = controller.getSnapshot(); queued = controller.getQueuedRecovery();
      }
      if (current.error === "startRejected" && (current.cause instanceof WritingCompactionAdmissionClosed || controller.getManualAdmission().blockedBeforeDispatch === "start")
        && !admission.isDisabled()) {
        const original = receipt(current); if (!original || !controller.dismiss()) return false;
        await controller.recover(original);
        current = controller.getSnapshot(); queued = controller.getQueuedRecovery(); manual = controller.getManualPreparation();
      }
      if (manual.recovery?.manual.start?.result) {
        await controller.retryManualPreparationLocal(); return controller.getSnapshot().outcome === "completed";
      }
      if (manual.recovery && (current.outcome || manual.phase === "localError" && manual.recovery.manual.result)) {
        await receipts.retry?.();
        if (current.outcome) await controller.clearManualPreparation(); else await controller.retryManualPreparationLocal();
        return current.outcome === "completed";
      }
      if (controller.history.getSnapshot().status === "error" && ["preview", "starting", "started"].includes(current.phase)) {
        await controller.history.resume();
        // This control is a read retry. A missing terminal is never authority
        // to restart a prepared task or settle a queued claim.
        return controller.getSnapshot().outcome === "completed";
      }
      if (queued) {
        await receipts.retry?.();
        if (controller.getSettlement().result) return await finishQueued(controller);
        if (!(await persistQueuedCompaction(controller, receipts, queued))) return false;
        if (current.phase === "idle" && queued.queued.prepare) {
          if (admission.isDisabled()) return false;
          await controller.prepare(queuedCompactionRequest(queued.queued.prepare));
        }
        else if (current.error === "prepare") {
          await controller.retryPrepare(true);
          if (!admission.isDisabled() && controller.getSnapshot().cause === "notFound" && queued.queued.prepare && controller.dismiss())
            await controller.prepare(queuedCompactionRequest(queued.queued.prepare));
        }
        if (controller.history.getSnapshot().status === "error") await controller.history.resume();
        if (canStart(controller) && !controller.getSnapshot().outcome) await confirm(controller);
        return await finishQueued(controller);
      }
      if (controller.history.getSnapshot().status === "error") {
        await controller.history.resume();
        if (restored.current && current.phase === "preview") return controller.getSnapshot().outcome === "completed";
      }
      if (current.phase === "error" && current.error === "prepare") {
        if (manual.recovery && !admission.isDisabled()) await controller.retryManualPreparation();
        else await controller.retryPrepare(true);
        const restoredState = controller.getSnapshot();
        if (!admission.isDisabled() && !manual.recovery && restoredState.error === "prepare" && restoredState.cause === "notFound" && restoredState.request)
          await controller.retryPrepare(false);
        if (controller.getManualPreparation().recovery?.manual.draftAcknowledgment && controller.getSnapshot().preview) {
          await controller.checkManualStart();
          const checked = controller.getManualPreparation();
          if (checked.recovery?.manual.start?.result) return controller.getSnapshot().outcome === "completed";
          if (checked.startStatus?.type !== "prepared") return false;
        }
      }
      if (manual.recovery?.manual.draftAcknowledgment && current.error === "start") {
        await controller.checkManualStart();
        const checked = controller.getManualPreparation();
        if (checked.recovery?.manual.start?.result) return controller.getSnapshot().outcome === "completed";
        if (checked.startStatus?.type !== "prepared") return false;
      }
      if (canStart(controller)) return await confirm(controller);
      if (current.phase === "started" && !current.outcome) {
        await controller.history.resume(); return waitForWritingCompaction(controller);
      }
      return controller.getSnapshot().outcome === "completed";
    } catch (cause: unknown) { setIssue({ key, cause }); return false; }
    finally { held.release(); }
  }
  async function checkPreparation(): Promise<boolean> {
    const held = retainOriginal(); if (!held) return false;
    try {
      const controller = held.controller, current = controller.getSnapshot(), manual = controller.getManualPreparation();
      if (controller.getQueuedAdmission().blockedBeforeDispatch === "prepare") return await controller.checkQueuedAdmissionBlock();
      if (controller.getQueuedRecovery()) {await controller.reconcileQueuedRetirement(); return false;}
      if (controller.getManualAdmission().blockedBeforeDispatch) {
        await controller.checkManualAdmissionBlock(); return controller.getSnapshot().outcome === "completed";
      }
      if (manual.recovery?.manual.draftAcknowledgment && manual.recovery.manual.result) {
        await controller.checkManualStart(); return controller.getSnapshot().outcome === "completed";
      }
      if (manual.recovery && current.outcome) {await controller.clearManualPreparation(); return current.outcome === "completed";}
      if (manual.recovery?.manual.result && manual.phase === "localError") await controller.retryManualPreparationLocal();
      else if (current.error === "prepare") await controller.retryPrepare(true);
      else if (controller.history.getSnapshot().status === "error") await controller.history.resume();
      if (controller.getManualPreparation().recovery?.manual.draftAcknowledgment && controller.getSnapshot().preview) await controller.checkManualStart();
      return false;
    } catch (cause: unknown) {setIssue({key, cause}); return false;}
    finally {held.release();}
  }
  async function discardPreparation(): Promise<boolean> {
    const held = retainOriginal(); if (!held) return false;
    try {
      const controller = held.controller, state = controller.getSnapshot();
      if (controller.getQueuedAdmission().blockedBeforeDispatch === "prepare") {
        const discarded = await controller.discardQueuedAdmissionBlock(receipts);
        if (discarded) {restored.current = false; setIssue(null);} return discarded;
      }
      if (controller.getQueuedRecovery()) {
        const retired = await controller.reconcileQueuedRetirement("begin") === "retired";
        if (retired) {restored.current = false; setIssue(null);} return retired;
      }
      let manual = controller.getManualPreparation(); if (!manual.recovery) return false;
      if (controller.getManualAdmission().blockedBeforeDispatch) {
        await controller.checkManualAdmissionBlock();
        if (!await controller.clearManualAdmissionBlock() || !controller.dismiss()) return false;
        controller.resetManualPreparation(); restored.current = false; setIssue(null); return true;
      }
      if (state.cause instanceof WritingCompactionAdmissionClosed) return false;
      if (manual.recovery.manual.start?.result || manual.priorStartUnknown) return false;
      if (!state.outcome && state.error !== "startRejected") {
        if (!manual.recovery.manual.knownRejected || manual.priorUnknown) return false;
        await controller.retryPrepare(true); manual = controller.getManualPreparation();
        if (manual.status?.type !== "notFound" || manual.priorUnknown || !manual.recovery?.manual.knownRejected) return false;
      }
      if (!await controller.clearManualPreparation(state.error === "startRejected")) return false;
      if (!controller.dismiss()) return false; controller.resetManualPreparation(); restored.current = false; setIssue(null); return true;
    } catch (cause: unknown) {setIssue({key, cause}); return false;}
    finally {held.release();}
  }
  function dismiss(): boolean {
    const controller = owner.current;
    if (!controller) return false;
    const state = controller.getSnapshot();
    const manual = controller.getManualPreparation();
    if (manual.recovery && manual.phase !== "done") return false;
    if (controller.queuedPending()) return false;
    // Native rejects this attempt after checking the currently visible task.
    // An older completed turn may have been rolled back; this is not proof
    // that R was never admitted. Other restore errors remain unresolved.
    const rejectedAtFence = state.error === "startRejected" && !!state.cause && typeof state.cause === "object"
      && "code" in state.cause && state.cause.code === "historyChanged";
    if (restored.current && !state.outcome && !rejectedAtFence) return false;
    const saved = receipt(state);
    if (!controller.dismiss()) return false;
    if (saved && !manual.recovery) {
      try { receipts.clear(saved); } catch (cause: unknown) { setIssue({ key, cause }); return false; }
    }
    if (manual.recovery) controller.resetManualPreparation();
    setIssue(null); return true;
  }
  const current = owned?.key === key ? owned : null;
  const state = current?.state ?? null;
  const queuedPending = owner.current?.queuedPending() ?? false;
  const settlement = owner.current?.getSettlement() ?? null;
  const manualPreparation = current?.manual ?? null;
  const pending = (!!state && state.phase !== "idle" && state.outcome === null) || queuedPending || !!owner.current?.manualPending();
  return { state, history: current?.history ?? null, issue: issue?.key === key ? issue.cause : settlement?.cause ?? manualPreparation?.cause,
    pending, queuedPending, settlement, queuedRecovery: owner.current?.getQueuedRecovery() ?? null,
    restored: restored.current, execute, executeQueued, recoverQueued, recoverExisting, retry, checkPreparation, discardPreparation, manualPreparation,
    manualAdmission: owner.current?.getManualAdmission() ?? null, queuedAdmission: owner.current?.getQueuedAdmission() ?? null, dismiss,
    queuedCancellation: current?.cancellation,
    queuedRetired: current?.retired ?? false,
    queuedInputId: state?.preview?.queued?.inputId ?? owner.current?.getQueuedRecovery()?.inputId,
    isPending: () => { const value = owner.current?.getSnapshot(); return (!!value && value.phase !== "idle" && value.outcome === null) || !!owner.current?.queuedPending() || !!owner.current?.manualPending(); },
    readQueued: gateway.readWritingQueued,
    savedQueued: () => {
      const saved = owner.current?.getQueuedRecovery() ?? (scope ? receipts.read(scope) : null);
      return saved && isWritingQueuedCompactionRecovery(saved) ? saved : null;
    },
    stop: () => owner.current?.stop() ?? Promise.resolve(),
  };
}
