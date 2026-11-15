import { useEffect, useRef, useState, type RefObject } from "react";
import { executionModeForModel, sameAgentWritingStartRequest, sameAgentWritingQueuePreviewRequest, sameAgentWritingQueuedStartRequest, sameAgentWritingPrepareRequest, type AgentInputDraft, type AgentSubmissionPreview, type AgentWritingQueuePreviewRequest } from "@research-assistant/core/agent";
import { notify, type NotificationAction } from "@research-assistant/workbench-sdk/feedback";
import { AGENT_START_FAILURE, recoverAgentPreparationFailure } from "@research-assistant/workbench-sdk/agent-submission";
import { useAgentMountedGuard } from "@research-assistant/workbench-sdk/agent-presentation";
import type { WritingSubmissionAdmission, WritingSubmissionController, WritingSubmissionSnapshot } from "@research-assistant/workbench-sdk/agent-writing";
import { writingQueueCancellationMessage } from "@research-assistant/workbench-sdk/agent-writing";
import { sameWritingQueueCancellationIntent } from "@research-assistant/workbench-sdk/agent-writing";
import {writingQueuePreparationMessage} from "@research-assistant/workbench-sdk/agent-writing";
import {writingWorkspacePreparationMessage} from "@research-assistant/workbench-sdk/agent-writing";
import {writingQueuedStartMessage} from "@research-assistant/workbench-sdk/agent-writing";
import type {WritingQueuedStartSnapshot} from "@research-assistant/workbench-sdk/agent-writing";
import {writingPreparationMessage} from "@research-assistant/workbench-sdk/agent-writing";
import type {WritingPreparationSnapshot} from "@research-assistant/workbench-sdk/agent-writing";

function originalPreviewEligible(owner: WritingSubmissionController, state: WritingSubmissionSnapshot): () => boolean {
  const original = state.preview, originalQueue = state.queue;
  return () => {const value = owner.getSnapshot(); return !!original && value.preview?.requestId === original.requestId
    && value.phase === state.phase && value.error === state.error
    && value.preview.conversationId === original.conversationId && value.preview.manuscriptId === original.manuscriptId
    && value.queue?.revision === originalQueue?.revision && value.queue?.preparingInputId === originalQueue?.preparingInputId;};
}

/** Only the original frozen receipt may retry an uncertain admission. */
export function useWritingSubmissionFeedback({state, controller, draft, originalDraft, restore, prepareWorkspace, holdPreparation, onAdmitted, reload, recover, observedTurn}: {
  readonly state: WritingSubmissionSnapshot | null;
  readonly controller: RefObject<WritingSubmissionController | null>;
  readonly draft: () => AgentInputDraft;
  readonly originalDraft: AgentInputDraft | undefined;
  readonly restore: (value: AgentInputDraft) => void;
  readonly prepareWorkspace: (preview: AgentSubmissionPreview) => Promise<boolean>;
  readonly holdPreparation: (intent: AgentWritingQueuePreviewRequest, eligible: () => boolean) => Promise<void>;
  readonly onAdmitted: ((value: WritingSubmissionAdmission) => void) | undefined;
  readonly reload: () => Promise<void>;
  readonly recover: () => Promise<void>;
  readonly observedTurn: boolean;
}) {
  const mounted = useAgentMountedGuard(), lastFailure = useRef<WritingSubmissionSnapshot | null>(null);
  const toast = useRef<string | number | undefined>(undefined);
  const [ownerRecovery, setOwnerRecovery] = useState<{message:string; actions:readonly NotificationAction[]} | null>(null);
  useEffect(() => {setOwnerRecovery(null);}, [state]);
  const reconciledAdmission = useRef<string | null>(null);
  // A definitive rejection may be retired automatically once for the live
  // draft owner. A failed cleanup remains recoverable through the notification.
  const automaticRetirements = useRef(new WeakMap<WritingSubmissionController, Set<string>>());
  function beginAutomaticRetirement(owner: WritingSubmissionController, key: string): boolean {
    let attempted = automaticRetirements.current.get(owner);
    if (!attempted) { attempted = new Set(); automaticRetirements.current.set(owner, attempted); }
    if (attempted.has(key)) return false;
    attempted.add(key);
    return true;
  }
  useEffect(() => () => { if (toast.current !== undefined) notify.dismiss(toast.current); }, []);
  async function resume(): Promise<void> {
    const owner = controller.current;
    if (!owner || !mounted.current) return;
    const saved = owner.getSnapshot(), frozen = saved.preview;
    const mode = frozen ? executionModeForModel(frozen.input.model, frozen.input.reasoningEffort) : null;
    if (!frozen || mode === null || !(saved.phase === "preview" || saved.error === "workspace" || saved.error === "start" || saved.error === "startRejected")) return;
    if (!await prepareWorkspace(frozen)) return;
    const current = owner.getSnapshot(), original = current.preview;
    if (!owner.isOriginalPreviewCurrent(frozen) || !original || original.requestId !== frozen.requestId
      || original.conversationId !== frozen.conversationId || original.manuscriptId !== frozen.manuscriptId
      || original.turnId !== frozen.turnId || original.contextSnapshotId !== frozen.contextSnapshotId
      || !(current.phase === "preview" || current.error === "start" || current.error === "startRejected")) return;
    await owner.confirm(mode, onAdmitted); await reload();
  }
  function show(message: string, action?: () => void | Promise<void>, label = "重新发送", cancel?: () => void | Promise<void>, cancelLabel = "返回编辑", eligible = () => true): void {
    const owner = controller.current;
    const protectedTask = !!owner && (owner.hasQueuedPreparation() || owner.hasWritingPreparation());
    if (toast.current !== undefined && !protectedTask) notify.dismiss(toast.current);
    const guarded = (run: () => void | Promise<void>) => async () => {if (mounted.current && controller.current === owner && eligible()) await run();};
    const primary: NotificationAction | null = action ? {id: "primary", label, onClick: guarded(action)} : null;
    const secondary: NotificationAction | null = cancel ? {id: "secondary", label: cancelLabel, onClick: guarded(cancel)} : null;
    if (message.includes("code=AGENT_PREVIEW_OWNER_INTENT_MISSING")) {
      setOwnerRecovery({message, actions:[primary,secondary].filter((value): value is NotificationAction => value !== null)});
      return;
    }
    toast.current = notify.error(message, {...(protectedTask ? {dismissible: false, ...(toast.current === undefined ? {} : {id: toast.current})} : {}),
      ...(protectedTask && primary && secondary ? {actions: [primary, secondary]}
        : {...(primary ? {action: primary} : {}), ...(secondary ? {cancel: secondary} : {})})});
  }
  function showStart(owner: WritingSubmissionController, starting: WritingQueuedStartSnapshot): void {
    const original = starting.intent && structuredClone(starting.intent), turnId = starting.turnId;
    const eligible = () => {const live = owner.getSnapshot().startRecovery; return !!original && !!live?.intent && live.turnId === turnId
      && live.phase === starting.phase && sameAgentWritingQueuedStartRequest(original, live.intent);};
    if (!original) show(writingQueuedStartMessage(starting));
    else if (starting.result) show(writingQueuedStartMessage(starting), () => owner.retryQueuedStart(false, onAdmitted).then(reload), "重试本机恢复", undefined, undefined, eligible);
    else show(writingQueuedStartMessage(starting), () => owner.checkQueuedStart(onAdmitted).then(reload), "核对原启动",
      () => (starting.phase === "notFound" || starting.phase === "unconfirmed" ? owner.checkQueuedStart(onAdmitted)
        : owner.retryQueuedStart(starting.queuePaused || starting.resumeCommand !== null, onAdmitted)).then(reload),
      starting.resumeCommand ? "核对原队列恢复" : starting.queuePaused ? "恢复队列并继续原启动"
        : starting.phase === "notFound" || starting.phase === "unconfirmed" ? "重试核对" : "重试原启动", eligible);
  }
  function showWritingStart(owner: WritingSubmissionController, preparing: WritingPreparationSnapshot): void {
    const start = preparing.start, original = preparing.intent;
    if (!start || !original) return;
    const eligible = () => {const live = owner.getSnapshot().writingPreparation; return !!live?.start && !!live.intent
      && live.phase === preparing.phase && sameAgentWritingStartRequest(live.start.request, start.request)
      && sameAgentWritingPrepareRequest(live.intent, original);};
    const inspect = () => owner.checkWritingPreparation(onAdmitted).then(reload);
    const retry = () => owner.retryWritingPreparation(onAdmitted).then(reload);
    const abandon = async () => {
      const text = await owner.abandonWritingPreparation();
      if (text !== null && mounted.current && controller.current === owner && owner.getSnapshot().writingPreparation?.phase === "retired")
        recoverAgentPreparationFailure({text, userInput: original.userInput ?? [], originalDraft: originalDraft ?? draft(), read: draft, restore, failureMessage: AGENT_START_FAILURE});
    };
    if (start.result) show(writingPreparationMessage(preparing), retry, "重试本机恢复", undefined, undefined, eligible);
    else show(writingPreparationMessage(preparing), inspect, "核对原启动", start.knownRejected && !start.priorUnknown ? abandon
      : preparing.startStatus?.type === "notFound" || preparing.startStatus?.type === "unconfirmed" ? inspect : retry,
      start.knownRejected && !start.priorUnknown ? "返回编辑" : preparing.startStatus?.type === "notFound" || preparing.startStatus?.type === "unconfirmed" ? "重试核对" : "重试原启动", eligible);
  }
  useEffect(() => {
    if (!state) return;
    const starting = state.startRecovery, startOwner = controller.current;
    if (starting && starting.phase !== "idle" && starting.phase !== "done" && startOwner) {
      if (["saving", "sending", "checking", "clearing"].includes(starting.phase)) return;
      if (lastFailure.current === state) return; lastFailure.current = state;
      showStart(startOwner, starting);
      return;
    }
    const preparing = state.writingPreparation;
    if (preparing?.start && startOwner?.hasWritingPreparation()) {
      if (["saving", "sending", "checking", "clearing"].includes(preparing.phase) || lastFailure.current === state) return;
      lastFailure.current = state;
      const original = preparing.intent;
      if (preparing.phase === "rejected" && original && originalDraft && !preparing.recovered
        && preparing.start.knownRejected && !preparing.start.priorUnknown && !preparing.start.result
        && beginAutomaticRetirement(startOwner, `start:${original.requestId}`)) {
        void (async () => {
          let text = await startOwner.abandonWritingPreparation();
          // A rejection is published before its in-flight persistence finishes.
          // The owner may only have waited for that operation; try the cleanup
          // once more after it settles, while the same rejection still owns it.
          const live = startOwner.getSnapshot().writingPreparation;
          if (text === null && mounted.current && controller.current === startOwner && live?.phase === "rejected"
            && live.intent && live.start?.knownRejected && !live.start.priorUnknown && !live.start.result
            && sameAgentWritingPrepareRequest(live.intent, original)
            && sameAgentWritingStartRequest(live.start.request, preparing.start!.request))
            text = await startOwner.abandonWritingPreparation();
          if (text !== null && mounted.current && controller.current === startOwner && startOwner.getSnapshot().writingPreparation?.phase === "retired")
            recoverAgentPreparationFailure({text, userInput: original.userInput ?? [], originalDraft, read: draft, restore, failureMessage: AGENT_START_FAILURE});
        })().catch(() => {if (mounted.current && controller.current === startOwner) showWritingStart(startOwner, preparing);});
      } else showWritingStart(startOwner, preparing);
      return;
    }
    if (preparing && startOwner?.hasWritingPreparation() && state.error === "prepare") {
      if (lastFailure.current === state) return; lastFailure.current = state;
      const original = preparing.intent && structuredClone(preparing.intent);
      const eligible = () => {const live = startOwner.getSnapshot().writingPreparation; return !!original && !!live?.intent
        && live.phase === preparing.phase && sameAgentWritingPrepareRequest(original, live.intent);};
      if (preparing.phase === "rejected" && original && originalDraft && !preparing.recovered
        && preparing.knownRejected && !preparing.priorUnknown && !preparing.knownCommitted
        && beginAutomaticRetirement(startOwner, `prepare:${original.requestId}`)) {
        void (async () => {
          await startOwner.retireWritingPreparation();
          const live = startOwner.getSnapshot().writingPreparation;
          if (mounted.current && controller.current === startOwner && live?.phase === "rejected"
            && live.intent && live.knownRejected && !live.priorUnknown && !live.knownCommitted
            && sameAgentWritingPrepareRequest(live.intent, original)) await startOwner.retireWritingPreparation();
          if (mounted.current && controller.current === startOwner && startOwner.getSnapshot().writingPreparation?.phase === "retired")
            recoverAgentPreparationFailure({text: original.text, userInput: original.userInput ?? [], originalDraft, read: draft, restore, failureMessage: AGENT_START_FAILURE});
        })().catch(() => {if (mounted.current && controller.current === startOwner) show(writingPreparationMessage(preparing));});
      } else if (!original) show(writingPreparationMessage(preparing));
      else show(writingPreparationMessage(preparing), () => startOwner.checkWritingPreparation(), "核对原准备",
        async () => {
          if (preparing.knownRejected && !preparing.priorUnknown) {
            await startOwner.retireWritingPreparation();
            if (mounted.current && controller.current === startOwner && startOwner.getSnapshot().writingPreparation?.phase === "retired")
              recoverAgentPreparationFailure({text: original.text, userInput: original.userInput ?? [], originalDraft: originalDraft ?? draft(), read: draft, restore, failureMessage: AGENT_START_FAILURE});
          } else await startOwner.retryWritingPreparation();
        }, preparing.knownCommitted ? "重试本机收尾" : preparing.knownRejected && !preparing.priorUnknown ? "返回编辑" : "重试原准备", eligible);
      return;
    }
    if (state.phase === "started" && state.outcome) {
      if (toast.current !== undefined) {notify.dismiss(toast.current); toast.current = undefined;}
      return;
    }
    const unsupported = state.phase === "preview" && state.preview
      && executionModeForModel(state.preview.input.model, state.preview.input.reasoningEffort) === null;
    if (!state.error && !unsupported && !(state.phase === "preview" && !state.request)) {
      if (controller.current?.hasQueuedPreparation() && ["preparing", "starting", "canceling"].includes(state.phase)) return;
      lastFailure.current = null;
      if (toast.current !== undefined) { notify.dismiss(toast.current); toast.current = undefined; }
      return;
    }
    if (lastFailure.current === state && !(state.error === "start" && observedTurn
      && state.preview && reconciledAdmission.current !== state.preview.requestId)) return;
    lastFailure.current = state;
    const owner = controller.current;
    if (!owner) return;
    const queued = owner.hasQueuedPreparation();
    const abandonOrdinary = async () => {
      const original = owner.getSnapshot().writingPreparation?.intent;
      if (!original) return; const text = await owner.abandonWritingPreparation();
      if (text !== null && mounted.current && controller.current === owner && owner.getSnapshot().writingPreparation?.phase === "retired")
        recoverAgentPreparationFailure({text, userInput: original.userInput ?? [], originalDraft: originalDraft ?? draft(), read: draft, restore, failureMessage: AGENT_START_FAILURE});
    };
    if (!queued && owner.hasWritingPreparation() && (state.error === "workspace" || unsupported)) {
      show(writingWorkspacePreparationMessage(state, !!unsupported), () => resume(), "重新发送", abandonOrdinary, "返回编辑", originalPreviewEligible(owner, state)); return;
    }
    if (!queued && (state.error === "workspace" || state.error === "startRejected" || unsupported)) {
      const request = state.request;
      owner.dismiss();
      recoverAgentPreparationFailure({text: request?.text ?? state.preview?.input.text ?? "", userInput: request?.userInput ?? [],
        originalDraft: originalDraft ?? draft(), read: draft, restore, failureMessage: AGENT_START_FAILURE,
        ...(unsupported ? {detail: "请重新选择模型。"} : state.error === "workspace" ? {detail: "无法准备可编辑副本，请检查当前文件后重试。"} : {})});
    } else if (state.error === "start") {
      if (observedTurn && state.preview && reconciledAdmission.current !== state.preview.requestId) {
        reconciledAdmission.current = state.preview.requestId;
        void resume(); return;
      }
      show("发送结果尚未确认，消息已保留在输入框中。重新发送将核对原请求，避免重复执行。", () => resume(), "重新发送", undefined, undefined, originalPreviewEligible(owner, state));
    } else if (state.error === "prepare" && queued) {
      const original = state.preparation?.intent && structuredClone(state.preparation.intent);
      const current = () => {const saved = owner.getSnapshot(), intent = saved.preparation?.intent;
        return !!original && !!intent && saved.error === "prepare" && saved.phase === state.phase
          && saved.preparation?.phase === state.preparation?.phase && sameAgentWritingQueuePreviewRequest(original, intent);};
      const cause = state.preparation?.cause;
      const locallyBlocked = cause !== null && typeof cause === "object" && "code" in cause && cause.code === "WRITING_DISPATCH_ADMISSION_CLOSED";
      const returnToQueue = !state.preparation?.knownCommitted && (state.preparation?.definitiveRejection || locallyBlocked);
      if (original) show(writingQueuePreparationMessage(state.preparation), () => owner.restoreQueuedPreparation().then(reload), "核对原准备",
        () => (returnToQueue ? owner.retireQueuedPreparation(holdPreparation) : owner.retryQueuedPreparation()).then(reload),
        state.preparation?.knownCommitted ? state.preparation.phase === "ready" ? "重读当前预览" : "重试本机清理" : returnToQueue ? "返回队列" : "重试原准备", current);
      else show(writingQueuePreparationMessage(state.preparation), state.preparation ? undefined : () => owner.restoreQueuedPreparation().then(reload), "核对原准备");
    } else if (state.error === "recover") {
      show("读取待发送请求失败，消息已保留，请重试。", () => recover());
    } else if (state.error === "stop") {
      show("停止请求失败，请重试。", () => owner.stop(), "重试停止");
    } else if (state.error === "cancel") {
      const original = state.cancellation?.intent && structuredClone(state.cancellation.intent);
      const current = () => {const intent = owner.getSnapshot().cancellation?.intent; return !!original && !!intent && sameWritingQueueCancellationIntent(original, intent);};
      if (!original) show(writingQueueCancellationMessage(state.cancellation));
      else show(writingQueueCancellationMessage(state.cancellation), () => current() ? owner.checkQueuedCancellation().then(reload) : undefined, "核对原取消",
        () => current() ? owner.retryQueuedCancellation().then(reload) : undefined, state.cancellation?.knownCommitted ? "重试本机清理"
          : state.cancellation?.definitiveConflict ? "刷新预览后重新取消" : "重试原取消");
    } else if (queued && state.error === "startRejected") {
      show("发送失败，队列消息已保留，请检查配置后重试。", () => resume(), "重新发送", undefined, undefined, originalPreviewEligible(owner, state));
    } else if (queued && (state.error === "workspace" || unsupported)) {
      show(writingWorkspacePreparationMessage(state), () => resume(), "重新发送",
        () => owner.cancelQueued(crypto.randomUUID()).then(reload), "返回编辑", originalPreviewEligible(owner, state));
    } else if (state.phase === "preview" && !state.request) {
      show(queued ? "有尚未发送的队列消息，请重新发送。" : "原准备已恢复，请明确继续原请求。", () => resume(), "重新发送",
        queued ? () => owner.cancelQueued(crypto.randomUUID()).then(reload) : owner.hasWritingPreparation() ? abandonOrdinary : undefined, "返回编辑", originalPreviewEligible(owner, state));
    }
  }, [state, observedTurn]);
  async function retryUncertain(text: string): Promise<boolean> {
    const owner = controller.current, saved = owner?.getSnapshot(), starting = saved?.startRecovery;
    const preparing = saved?.writingPreparation;
    if (owner && preparing?.start && owner.hasWritingPreparation()) {
      if (!["saving", "sending", "checking", "clearing"].includes(preparing.phase)) showWritingStart(owner, preparing);
      return true;
    }
    if (owner && starting && starting.phase !== "idle" && starting.phase !== "done") {
      if (!["saving", "sending", "checking", "clearing"].includes(starting.phase)) showStart(owner, starting);
      return true;
    }
    if (saved?.error !== "start") return false;
    if (text !== (saved.request?.text ?? saved.preview?.input.text)) {
      show("上次发送结果尚未确认，当前修改已保留。请先核对原请求。", () => void resume());
    } else await resume();
    return true;
  }
  return {retryUncertain, ownerRecovery};
}
