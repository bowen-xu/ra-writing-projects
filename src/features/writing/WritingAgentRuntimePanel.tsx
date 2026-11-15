import {useWritingEditableWorkspace} from "./agent/useWritingEditableWorkspace";
import { holdRejectedQueuePreparation } from "@research-assistant/workbench-sdk/agent-submission";
import {useWritingQueuedStartRecovery} from "./agent/useWritingQueuedStartRecovery";
import type { WritingAgentRuntimeProps as ProductionProps } from "./agent/writingRuntimeProps";
import { useAgentContextUsage } from "@research-assistant/workbench-sdk/agent-context-controls";
import { useWritingSubmissionFeedback } from "./agent/useWritingSubmissionFeedback";
import { useWritingMetadataSend } from "./agent/useWritingMetadataSend";
import { recoverAgentPreparationFailure } from "@research-assistant/workbench-sdk/agent-submission";
import { useWritingExternalSubmission } from "./agent/useWritingExternalSubmission";
import { addToolRecoveryFallbacks } from "./agent/toolRecoveryPresentation";
import { useContextContribution } from "@research-assistant/workbench-sdk/agent-context-controls";
import { useConversationSteeringHandoff } from "@research-assistant/workbench-sdk/agent-context-controls";
import { useHiddenHandoffQueueInputs } from "@research-assistant/workbench-sdk/agent-context-controls";
import { writingQueuePreparingPresentation } from "@research-assistant/workbench-sdk/agent-submission";
import { useAgentSteeringOwners } from "@research-assistant/workbench-sdk/agent-submission";
import { agentContextGateway } from "@research-assistant/workbench-sdk/agent-context-controls";
import { recoverRejectedSteer, pauseRejectedSteerQueue } from "@research-assistant/workbench-sdk/agent-submission";
import { readMessageInspection } from "@research-assistant/workbench-sdk/agent-presentation";
import { AgentSteeringReceipt } from "@research-assistant/workbench-sdk/agent-submission";
import { AgentPendingSteeringBubbles } from "@research-assistant/workbench-sdk/agent-submission";
import { AgentPendingSubmissionBubble, hasConfirmedSubmissionMessage, type PendingAgentSubmission } from "@research-assistant/workbench-sdk/agent-submission";
import { AgentTransientFailure } from "@research-assistant/workbench-sdk/agent-presentation";
import { AgentRecoveryMessage } from "@research-assistant/workbench-sdk/agent-presentation";
import {diagnosticError} from "@research-assistant/workbench-sdk/agent-diagnostics";
import { AgentSteeringHandoffRecovery } from "@research-assistant/workbench-sdk/agent-submission";
import { reconcileSteeringTransfer } from "@research-assistant/workbench-sdk/agent-submission";
import { useAgentDraftStore, useConversationDraft } from "@research-assistant/workbench-sdk/agent-drafts";
import { queueDraftEdit } from "@research-assistant/workbench-sdk/agent-drafts";
import type { AgentCommandExecution } from "@research-assistant/workbench-sdk/agent-submission";
import { useWritingCompaction } from "./agent/useWritingCompaction";
import { WritingCompactionFeedback } from "./agent/WritingCompactionFeedback";
import { prepareWritingCompaction, prepareQueuedWritingCompaction } from "./agent/writingCompactionPreparation";
import { getRuntimeEnvironment, getNativePreviewCapabilities, captureNewPreviewOwnerIntent, freezeNewPreviewOwnerIntent } from "@research-assistant/workbench-sdk/environment";
import { dispatchQueuedAgentCommand } from "@research-assistant/workbench-sdk/agent-submission";
import { executeWritingQueuedCompaction, recoverWritingQueueCompaction } from "./agent/writingQueuedCompactionExecution";
import { readComposerCommand } from "@research-assistant/workbench-sdk/agent-submission";
import { nameInitialConversation } from "@research-assistant/workbench-sdk/agent-conversations";
import type { ConversationDraftStore } from "@research-assistant/workbench-sdk/agent-drafts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {captureWritingDraftReceipt, unownedWritingDraftReceipt, writingDraftAcknowledgments, type WritingDraftReceipt} from "@research-assistant/workbench-sdk/agent-writing";
import { agentConversationRequiresToolRecovery, agentDraftInput, executionModeForModel, type AgentInputDraft, type AgentWorkspaceBuffer, type AgentWorkspaceScope, type AgentUserInput } from "@research-assistant/core/agent";
import { WritingWorkspaceChangeSummary } from "./agent/WritingWorkspaceReview";
import { useWritingTurnChangeScopes } from "./agent/useWritingTurnChangeScopes";
import { agentSubmissionGateway, agentInputQueueGateway, agentInputQueuePreviewGateway, agentSubtaskGateway, agentMetadataGateway, agentCatalogGateway, agentWorkspaceGateway, agentWorkspaceReviewGateway, agentCompactionGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { agentTurnGateway, agentSessionGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { aiAssistanceErrorMessage, getAiAssistanceGateway } from "@research-assistant/workbench-sdk/ai-assistance";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { acquireWritingSubmissionController, releaseWritingSubmissionController, type WritingSubmissionSnapshot } from "@research-assistant/workbench-sdk/agent-writing";
import { WritingAgentPanel, type WritingAgentMessage, type WritingAgentSubmitOptions } from "@research-assistant/workbench-sdk/agent-presentation";
import "./WritingAgentRuntimePanel.css";
import { useWritingSteering } from "./agent/useWritingSteering";
import { captureWritingSubmissionSources } from "./agent/writingSubmissionSources";

import { useWritingInputQueue } from "./agent/useWritingInputQueue";
import { useAgentQueueAutoPrepare } from "@research-assistant/workbench-sdk/agent-submission";
import { WritingAgentTaskStack } from "@research-assistant/workbench-sdk/agent-presentation";
import { useConversationForkActions } from "@research-assistant/workbench-sdk/agent-conversations";
import { ConversationForkOrigin } from "@research-assistant/workbench-sdk/agent-conversations";
import { PaperConceptRetrievalControl } from "@research-assistant/workbench-sdk/concept-retrieval";
import { useAgentChildTasks } from "@research-assistant/workbench-sdk/agent-presentation";
import { useAgentHostLifecycle } from "@research-assistant/workbench-sdk/agent-presentation";
import { writingQueueCancellationRecovery } from "@research-assistant/workbench-sdk/agent-writing";
import { useWritingConversationCreation } from "./agent/useWritingConversationCreation";
import { ConversationCreationRecovery } from "@research-assistant/workbench-sdk/agent-conversations";
import {useWritingRuntimeAdmission} from "./persistence/writingRuntimeAdmission";

import { acquireWritingRetrievalOwner, setWritingRetrievalOwner, type WritingPendingRetrieval, type WritingRetrievalOwner } from "./agent/writingRetrievalOwners";
export { resetWritingRetrievalOwnersForTests } from "./agent/writingRetrievalOwners";

type Props = ProductionProps;

function changeScopeKey(scope: AgentWorkspaceScope): string {
  return JSON.stringify([scope.conversationId, scope.manuscriptId, scope.requestId, scope.contextSnapshotId]);
}

export function WritingAgentRuntimePanel(props: Props): React.JSX.Element {
  return <WritingAgentRuntimePanelWithDrafts {...props} />;
}

function WritingAgentRuntimePanelWithDrafts(props: ProductionProps): React.JSX.Element {
  const drafts = useAgentDraftStore();
  return <ScopedWritingAgentRuntimePanel key={`${props.gateways?.identity ?? "desktop"}:${props.manuscriptId}:${props.conversationId}`} {...props} drafts={drafts} />;
}
function ScopedWritingAgentRuntimePanel(props: ProductionProps & { readonly drafts: ConversationDraftStore }): React.JSX.Element {
  const {disabled: runtimeDisabled, isDisabled: isRuntimeDisabled} = useWritingRuntimeAdmission();
  // Pending identities exist only in the UI. Keep durable readers detached
  // until the first non-empty submission creates the conversation.
  const pendingConversation = props.pendingConversationId === props.conversationId;
  const [contextModel, setContextModel] = useState<Parameters<typeof useAgentContextUsage>[2]>();
  const contextUsage = useAgentContextUsage(pendingConversation ? null : props.projection, props.gateways?.contextUsage, contextModel);
  const submissionGateway = props.gateways?.submission ?? agentSubmissionGateway;
  const turnsGateway = props.gateways?.turns ?? agentTurnGateway;
  const queuePreviewGateway = props.gateways?.queuePreview ?? agentInputQueuePreviewGateway;
  const workspaceGateway = props.gateways?.workspace ?? agentWorkspaceGateway;
  const subtasksGateway = props.gateways?.subtasks ?? agentSubtaskGateway;
  const runtime = getRuntimeEnvironment();
  const draftAcknowledgments = useMemo(() => writingDraftAcknowledgments(props.drafts), [props.drafts]);
  const compactSupported = props.gateways ? !!props.gateways.compaction : runtime.mode === "desktop"
    || !!getNativePreviewCapabilities(runtime)?.supportsManualCompaction;
  const compaction = useWritingCompaction({
    scope: compactSupported && props.manuscriptId && props.conversationId ? {
      identity: props.gateways?.identity ?? getNativePreviewCapabilities(runtime)?.generation ?? "desktop",
      manuscriptId: props.manuscriptId, conversationId: props.conversationId } : null,
    gateway: props.gateways?.compaction ?? agentCompactionGateway, turns: turnsGateway, draftAcknowledgments,
    submission: submissionGateway, queuePreview: queuePreviewGateway,
    submissionOwnerKey: JSON.stringify([props.gateways?.identity ?? "desktop", props.manuscriptId ?? null, props.conversationId ?? null]),
    queue: props.gateways?.queue.gateway ?? agentInputQueueGateway,
    history: props.gateways?.history ?? agentSessionGateway, ...(props.projection ? { projection: props.projection } : {}),
  });
  const [capturingCompaction, setCapturingCompaction] = useState(false);
  const [, setDraft, captureAcknowledgment, draftResources] = useConversationDraft(props.drafts, props.manuscriptId
    ? { hostKind: "manuscript", hostId: props.manuscriptId, conversationId: pendingConversation ? null : props.conversationId } : null, false);
  const [state, setState] = useState<WritingSubmissionSnapshot | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<PendingAgentSubmission | null>(null);
  const [sendingSubmission, setSendingSubmission] = useState(false);
  const sendingSubmissionRef = useRef(false);
  const sendCancellationEpoch = useRef(0);
  const activeOwnerRequest = useRef<string | null>(null);
  const cancelledOwnerSubmission = useRef<{requestId: string; submissionId: string | null} | null>(null);
  const captureOwner = useRef<symbol | null>(null);
  const [cancelSendingPending, setCancelSendingPending] = useState(false);
  const [queueStopFailure, setQueueStopFailure] = useState<string | null>(null);
  const [sendStopFailure, setSendStopFailure] = useState<string | null>(null);
  const activeSubmissionId = useRef<string | null>(null);
  const previousSubmissionRequest = useRef<string | null>(null);
  const childRefresh = `${props.projection?.activeTurn ?? "idle"}:${state?.phase ?? "idle"}:${state?.outcome ?? "none"}`;
  const { tasks: childTasks, reload: reloadChildTasks } = useAgentChildTasks(pendingConversation ? null : props.conversationId, childRefresh, undefined, subtasksGateway);
  const frozenWorkspace = useRef<{ requestId: string; buffers: readonly AgentWorkspaceBuffer[] | null; draft: AgentInputDraft } | null>(null);
  const capturingSources = useRef(false);
  const metadataIssue = props.metadataLoading ? undefined : props.metadataUnavailable;
  const resumeMetadataSend = useRef(submit);
  const queueReady = !pendingConversation && props.historyReady && !props.hostFailure && !props.archived && !props.metadataUnavailable && !props.metadataLoading;
  const queue = useWritingInputQueue(props.manuscriptId, pendingConversation ? null : props.conversationId, queueReady, props.gateways?.queue);
  const queueWasReady = useRef(false);
  const steeringOwners=useAgentSteeringOwners();
  const handoffGateway=props.gateways?.context ?? agentContextGateway;
  const handoffRegistry=props.gateways ? props.gateways.steeringHandoff : steeringOwners?.handoffs;
  const handoff=useConversationSteeringHandoff(props.conversationId??"",handoffGateway,handoffRegistry,
    !pendingConversation && props.historyReady && !props.archived,props.projection??null,async()=>{
      const owner=queue.controller.current;if(!owner)return false;
      const before=owner.getSnapshot().readSequence??0;await owner.reload();const after=owner.getSnapshot();
      return queue.controller.current===owner && !after.loading && !after.error && !after.uncertain && (after.readSequence??0)>before;
    },{kind:"manuscript",manuscriptId:props.manuscriptId??""},queue.state?.readSequence??0,isRuntimeDisabled);
  const handoffBlocked=!pendingConversation && !!props.conversationId && (!handoff.available || handoff.blocked);
  // The original queue entry remains fenced until its history is settled, but
  // a confirmed admission must not prevent independent new input in this turn.
  const pendingHandoffIntents = [...(handoff.state?.items.map(item=>item.intent)??[]),...(handoff.state?.intent?[handoff.state.intent]:[])];
  const acceptedHandoff = handoff.state?.phase === "waiting" && pendingHandoffIntents.length > 0
    && handoff.state.items.every(item=>item.history!=="incompleteOrConflicting")
    && pendingHandoffIntents.every(intent=>intent.turnId===props.projection?.activeTurn
      && handoff.state?.acceptedOperationIds?.includes(intent.operationId));
  const handoffInputBlocked = handoffBlocked && !acceptedHandoff;
  const handoffNeedsAttention=handoffBlocked && (!handoff.available || handoff.state?.phase === "uncertain" || handoff.state?.phase === "error"
    || (handoff.state?.phase === "waiting" && handoff.state.items.some(item => item.history === "incompleteOrConflicting" && props.projection?.turns.get(item.intent.turnId)?.outcome != null)));
  const showQueue = !pendingConversation && !!queue.state && (!!queue.state.queue?.inputs.length || !!queue.state.queue?.preparingInputId || !!queue.state.error || !!queue.state.uncertain);
  const lastSubmitOptions = useRef<WritingAgentSubmitOptions | null>(null);
  const manualQueueDispatch = useRef(false);
  const [dispatchingQueue, setDispatchingQueue] = useState(false);
  const [activeQueueDispatch, setActiveQueueDispatch] = useState<{ inputId: string; token: symbol } | null>(null);
  const activeQueueDispatchRef = useRef<symbol | null>(null);
  const [pendingRetrieval, setPendingRetrieval] = useState<WritingPendingRetrieval | undefined>(undefined);
  const retrievalEpoch = useRef(0);
  const retrievalQueued = useRef<WritingPendingRetrieval["queued"]>(undefined);
  const retrievalRequestId = useRef<string | undefined>(undefined);
  const retrievalOwnerRef = useRef<WritingRetrievalOwner | null>(null);
  const aiGateway = props.gateways?.retrieval ?? getAiAssistanceGateway();
  const controller = useRef<ReturnType<typeof acquireWritingSubmissionController> | null>(null);
  const acceptContext = useRef<(requestId: string) => Promise<void>>(async () => {throw new Error("CONTEXT_CONFIGURATION_OWNER_UNAVAILABLE");});
  const currentTitle = useRef(props.conversationTitle); currentTitle.current = props.conversationTitle;
  const lifecycleRef = useAgentHostLifecycle([props.manuscriptId, props.conversationId]);
  const { creation, ensureConversation, captureAdoption, finished: creationFinished } = useWritingConversationCreation(props, pendingConversation, lifecycleRef);
  useEffect(() => {
    const lease = acquireWritingRetrievalOwner(props.manuscriptId, props.conversationId, props.gateways?.identity);
    const owner = lease.owner;
    retrievalOwnerRef.current = owner;
    const sync = () => setPendingRetrieval(owner.pending);
    owner.listeners.add(sync);
    sync();
    return () => {
      owner.listeners.delete(sync);
      lease.release();
      if (retrievalOwnerRef.current === owner) retrievalOwnerRef.current = null;
    };
  }, [props.manuscriptId, props.conversationId, props.gateways?.identity]);
  useEffect(() => {
    const ownerKey = JSON.stringify([props.gateways?.identity ?? "desktop", props.manuscriptId ?? null, props.conversationId ?? null]);
    const value = acquireWritingSubmissionController(ownerKey, submissionGateway, turnsGateway, queuePreviewGateway, writingQueueCancellationRecovery(props), isRuntimeDisabled);
    value.configureDraftAcknowledgments(draftAcknowledgments);
    const releaseContextAcceptance = value.configureContextAcceptance(requestId => acceptContext.current(requestId));
    controller.current = value;
    setState(value.getSnapshot());
    const unsubscribe = value.subscribe(() => setState(value.getSnapshot()));
    return () => { unsubscribe(); releaseContextAcceptance(); releaseWritingSubmissionController(ownerKey, value); controller.current = null; };
  }, [props.conversationId, props.manuscriptId, props.gateways?.identity, submissionGateway, turnsGateway, queuePreviewGateway, draftAcknowledgments, isRuntimeDisabled]);
  useEffect(() => {
    if (!props.historyReady) return;
    const turnId = state?.admission?.turnId ?? state?.preview?.turnId;
    if (!turnId) return;
    const outcome = props.projection?.turns.get(turnId)?.outcome;
    if (outcome) controller.current?.observeOutcome(turnId, outcome);
  }, [props.historyReady, props.projection, state?.admission, state?.preview, state?.phase]);
  useEffect(() => {
    const alreadyReady = queueWasReady.current;
    queueWasReady.current = queueReady;
    // useWritingInputQueue reads whenever readiness is first established.
    if (queueReady && alreadyReady
      && (state?.phase === "started" || compaction.state?.preview?.queued || props.projection?.activeTurn === null)) void queue.controller.current?.reload();
  }, [state?.phase, state?.outcome, compaction.state?.preview?.requestId, compaction.state?.outcome, compaction.settlement?.phase, props.projection?.activeTurn, queue.controller, queueReady]);
  const activeTurn = props.projection?.activeTurn ?? null;
  const toolRecoveryBlocked = activeTurn === null && !!props.projection && agentConversationRequiresToolRecovery(props.projection);
  const activeTaskKind = activeTurn ? props.projection?.turns.get(activeTurn)?.taskKind : undefined;
  const activeTurnStartedAtMs = activeTurn === null ? undefined : props.projection?.turns.get(activeTurn)?.startedAtMs;
  const running = activeTurn !== null || (state?.phase === "started" && state.outcome === null);
  const steeringTurn = activeTaskKind === "compact" ? null : activeTurn ?? (state?.phase === "started" && !state.outcome
    && state.preview?.conversationId === props.conversationId && state.preview.manuscriptId === props.manuscriptId ? state.preview.turnId : null);
  const steering = useWritingSteering(!pendingConversation && props.manuscriptId && props.conversationId && steeringTurn && props.historyReady
    ? { manuscriptId: props.manuscriptId, conversationId: props.conversationId, turnId: steeringTurn } : null,
    (text) => setDraft((current) => current.trim() === text ? "" : current),props.historyReady?props.projection:null,props.manuscriptId&&props.conversationId?{key:JSON.stringify([props.manuscriptId,props.conversationId]),conversationId:props.conversationId,captureAcknowledgment,queueRejected:(request,ack)=>recoverRejectedSteer(queue.acquireOwner(),request,ack??(()=>undefined),isRuntimeDisabled)}:undefined, props.gateways?.steering,{state:queue.state,isReady:()=>{const current=queue.controller.current?.getSnapshot();return !!current?.queue&&!current.loading&&!current.editing&&!current.uncertain&&!current.error;}});
  const visibleMessages = props.messages;
  const recoveryMessages = toolRecoveryBlocked && props.projection?.conversationId === props.conversationId
    ? addToolRecoveryFallbacks(props.projection, visibleMessages) : visibleMessages;
  const hiddenHandoffInputs = useHiddenHandoffQueueInputs(JSON.stringify([props.manuscriptId,props.conversationId]),props.conversationId??"",handoff.state,queue.state,visibleMessages);
  const commands: AgentCommandExecution = { compact: compact, pending: compaction.pending || capturingCompaction, usage: undefined, activities: [] };
  const compactRequestId = compaction.state?.preview?.requestId ?? compaction.state?.request?.request.requestId ?? compaction.state?.recoveryReceipt?.requestId;
  const submissionPending = state !== null && (state.startRecovery?.phase !== undefined && state.startRecovery.phase !== "done"
    || state.writingPreparation && !["idle", "complete", "retired"].includes(state.writingPreparation.phase)
    || state.phase !== "idle" && !(state.phase === "started" && state.outcome));
  const pending = commands.pending || submissionPending;
  const contextReadOnly=!!props.archived||(!pendingConversation&&(!props.historyReady||!!props.metadataLoading||!!props.metadataUnavailable));
  const contribution=useContextContribution(props.conversationId,runtimeDisabled||!!props.archived||!props.historyReady||running||pending,props.gateways?.resources,props.manuscriptId,pendingConversation,props.gateways?.context,{readOnly:contextReadOnly});
  acceptContext.current = contribution.accept;
  const queuePreparingInputId = queue.state?.queue?.preparingInputId;
  const startedCompactionInputId = compaction.queuedPending && compaction.state?.phase === "started" && compaction.state.outcome === null
    ? compaction.queuedInputId : null;
  const queuePreparingStatus = queuePreparingInputId && queuePreparingInputId === startedCompactionInputId
    ? "sent" : writingQueuePreparingPresentation(queuePreparingInputId, state, activeQueueDispatch?.inputId);
  const queueRecoveryDisabled = !!props.archived || handoffBlocked || (!pendingConversation && !contribution.ready)
    || !!steering.state.awaitingHistory?.length || dispatchingQueue || !queueReady || steering.unresolved
    || !!queue.state?.loading || !!queue.state?.editing || !!queue.state?.uncertain || hiddenHandoffInputs.length > 0
    || state?.phase === "preparing" || state?.phase === "starting";
  const contextBusy = !pendingConversation && !contextReadOnly && (contribution.loading || contribution.saving);
  const contextIssue = !pendingConversation && !contextReadOnly && !contribution.ready && !contextBusy
    ? "无法恢复对话上下文。" : undefined;
  const metadataSend = useWritingMetadataSend<Parameters<typeof submit>>({loading: !!props.metadataLoading || contextBusy, issue: metadataIssue ?? contextIssue,
    ready: !pendingConversation && props.historyReady && !contextReadOnly && contribution.ready && !handoffInputBlocked,
    active: props.open && !props.archived, retry: metadataIssue ? props.onRetryMetadata : undefined,
    send: (...request) => {
      const submissionId = activeSubmissionId.current;
      sendingSubmissionRef.current = true; setSendingSubmission(true);
      return resumeMetadataSend.current(...request).finally(() => {if (activeSubmissionId.current === submissionId) {sendingSubmissionRef.current = false; setSendingSubmission(false);}});
    }});
  const waitingForMetadata = metadataSend.waiting;
  useEffect(() => {
    const preparation = state?.writingPreparation;
    const intent = preparation?.intent;
    if (pendingSubmission || !controller.current?.hasWritingPreparation() || !preparation || !intent
      || intent.conversationId !== props.conversationId || intent.context.manuscriptId !== props.manuscriptId
      || ["idle", "complete", "retired"].includes(preparation.phase)
      || state?.error === "workspace"
      || state?.phase === "preview" && !!state.preview && executionModeForModel(state.preview.input.model, state.preview.input.reasoningEffort) === null
      || preparation.knownRejected && !preparation.priorUnknown
      || preparation.start?.knownRejected && !preparation.start.priorUnknown) return;
    const restored: PendingAgentSubmission = {id: intent.requestId, conversationId: intent.conversationId, text: intent.text,
      userInput: intent.userInput, ...(preparation.result ? {turnId: preparation.result.turnId} : {})};
    if (hasConfirmedSubmissionMessage(restored, visibleMessages)) return;
    previousSubmissionRequest.current = null;
    activeSubmissionId.current = intent.requestId;
    setPendingSubmission(restored);
  }, [pendingSubmission, props.conversationId, props.manuscriptId, state, visibleMessages]);
  useEffect(() => {
    if (!pendingSubmission) return;
    const cancelled = cancelledOwnerSubmission.current;
    if (cancelled && cancelled.submissionId === pendingSubmission.id
      && state?.writingPreparation?.phase === "retired"
      && state.writingPreparation.intent?.requestId === cancelled.requestId
      && !controller.current?.isCancelPending(cancelled.requestId)) {
      cancelledOwnerSubmission.current = null;
      if (activeSubmissionId.current === cancelled.submissionId) {
        activeSubmissionId.current = null;
        sendingSubmissionRef.current = false;
        setSendingSubmission(false);
      }
      setPendingSubmission(null);
      return;
    }
    if (state?.phase === "started" && hasConfirmedSubmissionMessage(pendingSubmission, visibleMessages)) {setPendingSubmission(null); return;}
    const request = state?.request ?? state?.writingPreparation?.intent;
    if (!request || request.requestId === previousSubmissionRequest.current) return;
    const rejected = state?.error === "workspace"
      || state?.phase === "preview" && !!state.preview && executionModeForModel(state.preview.input.model, state.preview.input.reasoningEffort) === null
      || state?.error === "startRejected" && !state.writingPreparation?.start?.priorUnknown
      || state?.error === "prepare" && !!state.writingPreparation?.knownRejected && !state.writingPreparation.priorUnknown;
    if (rejected) {setPendingSubmission(null); return;}
    if (state?.preview && pendingSubmission.turnId !== state.preview.turnId)
      setPendingSubmission(current => current ? {...current, turnId: state.preview!.turnId} : null);
    if (state?.phase === "started" && state.admission) {
      sendingSubmissionRef.current = false; setSendingSubmission(false);
    }
  }, [pendingSubmission, state, visibleMessages]);
  useEffect(() => {
    if (!pendingSubmission || sendingSubmission || waitingForMetadata || pendingRetrieval) return;
    const request = state?.request ?? state?.writingPreparation?.intent;
    if (!request || request.requestId === previousSubmissionRequest.current) setPendingSubmission(null);
  }, [pendingSubmission, sendingSubmission, waitingForMetadata, pendingRetrieval, state]);
  const visibleRequest = state?.request ?? state?.writingPreparation?.intent;
  const admittedSubmission = !!visibleRequest && visibleRequest.requestId !== previousSubmissionRequest.current && state?.phase === "started";
  // Admission is published before the original draft acknowledgment and the
  // durable start cleanup finish. Keep the same editor covered through that
  // asynchronous boundary; local failures remain available to recovery.
  const admittedFinishing = state?.writingPreparation?.phase === "clearing" && !!state.writingPreparation.start?.result
    || state?.startRecovery?.phase === "clearing" && !!state.startRecovery.result;
  const activeQueueAwaitingAdmission = !!activeQueueDispatch
    && !(state?.startRecovery?.intent?.inputId === activeQueueDispatch.inputId && state.startRecovery.result)
    && activeQueueDispatch.inputId !== startedCompactionInputId;
  // A failed or uncertain stop needs an actionable recovery, not an endless
  // progress mask. Keep its original request fenced from resubmission.
  const sendStopNeedsRecovery = !!state?.sendStopIntentUnavailable || !!state?.sendStopFailed || !!state?.sendStopNeedsReview
    || !!state?.cancelSendRequested && state.phase === "error";
  const visibleSubmissionSending = !sendStopNeedsRecovery && ((sendingSubmission || !!pendingSubmission) && !admittedSubmission
    || admittedFinishing || activeQueueAwaitingAdmission);
  const stoppingSubmission = cancelSendingPending || !!state?.cancelSendRequested && !sendStopNeedsRecovery;
  const canCancelSubmission = !!pendingSubmission || sendingSubmission || waitingForMetadata || !!activeQueueDispatch
    || !!admittedFinishing || queuePreparingStatus === "sending" || !!state?.cancelSendRequested;
  const queueUnresolved = !!queue.state?.editing || !!queue.state?.uncertain;
  const autoPrepare = useAgentQueueAutoPrepare(
    running,
    queue.state?.queue?.inputs.find(input => !input.paused) ?? null,
    runtimeDisabled || toolRecoveryBlocked || handoffBlocked || !!steering.state.awaitingHistory?.length || steering.unresolved || dispatchingQueue || cancelSendingPending || !!queueStopFailure || !!state?.heldQueueInputId || !!state?.queueStopHoldUnavailable || !!state?.cancelSendRequested || !!state?.sendStopIntentUnavailable || !!pendingRetrieval || !queueReady || !contribution.ready || !!queue.state?.loading || queueUnresolved || pending || (!!state && !(state.phase === "idle" || (state.phase === "started" && state.outcome))) || !!queue.state?.queue?.paused || !!queue.state?.queue?.preparingInputId,
    (input) => { const live = queue.controller.current?.getSnapshot(); if (isRuntimeDisabled() || !live || live.loading || live.editing || live.uncertain || live.queue?.preparingInputId) return false; const options = lastSubmitOptions.current; if (options) void submit(input.text, {...options, userInput: input.userInput ?? []}, { inputId: input.inputId, revision: queue.state?.queue?.revision ?? 0, autoDispatch: true }); },
  );
  const disabledReason = (runtimeDisabled ? "写作插件正在停用或需要恢复，原任务和草稿已保留。" : props.hostFailure ? "稿件读取失败，请先处理。" : toolRecoveryBlocked ? "工具操作尚待核对，请勿重复提交。" : state?.cancelSendRequested || state?.sendStopIntentUnavailable || state?.queueStopHoldUnavailable || state?.heldQueueInputId || queueStopFailure ? "停止发送尚待核对，原消息已保留。" : handoffInputBlocked && queueReady ? (handoffNeedsAttention ? "队列引导尚未核对" : "引导等待处理") : steering.unresolved ? steering.status : queueUnresolved ? "请先核对原队列操作，不能重复提交。" : undefined) ?? (props.archived ? "此对话已归档，请在对话列表的已归档筛选中恢复后继续。" : !props.conversationId ? "请先在对话列表中新建或打开对话"
    : !pendingConversation && !props.historyReady ? "正在读取对话历史" : submissionPending && !running && state?.error !== "start" ? "请先处理本次提交" : undefined);
  const prepareEditableWorkspace = useWritingEditableWorkspace({gateway: workspaceGateway, controller, frozenWorkspace});
  const externalModel = useRef<WritingAgentSubmitOptions["modelSelection"]>(undefined);
  useWritingExternalSubmission({messageRequest: props.messageRequest ?? null, ready: props.historyReady && !props.metadataLoading && contribution.ready,
    blocked:runtimeDisabled || !!props.hostFailure || toolRecoveryBlocked || handoffBlocked || (!pendingConversation && !contribution.ready) || running || state?.phase === "preview" || state?.phase === "starting" || !!props.archived || !props.conversationId || steering.unresolved || queueUnresolved, controller, submit, readModel:()=>externalModel.current});
  async function compact(text: string, commandOptions: { readonly preserveDraft?: boolean; readonly requestId?: string;
    readonly queued?: {readonly inputId: string; readonly explicit: boolean}; readonly draftReceipt?: WritingDraftReceipt } = {}): Promise<boolean> {
    if (isRuntimeDisabled()) return false;
    const command = readComposerCommand(text), selection = lastSubmitOptions.current;
    if (!command || command.name !== "compact" || command.arguments) { notify.error("请只输入 /compact，不接受额外参数。"); return false; }
    if (!compactSupported) { notify.info("当前运行环境尚未接入原生上下文压缩。"); return false; }
    if (toolRecoveryBlocked || handoffBlocked || (!pendingConversation && !contribution.ready) || !selection || !props.manuscriptId || !props.conversationId || running || props.archived || metadataIssue || props.metadataLoading
      || (!pendingConversation && !props.historyReady) || capturingSources.current || submissionPending) return false;
    const epoch = lifecycleRef.current, requestId = commandOptions.requestId ?? crypto.randomUUID();
    const compactConversationId = props.conversationId;
    let captureOwnerIntent: ReturnType<typeof captureNewPreviewOwnerIntent>;
    try { captureOwnerIntent = captureNewPreviewOwnerIntent(runtime, compactConversationId); }
    catch (reason: unknown) { notify.error(aiAssistanceErrorMessage(reason)); return false; }
    const expectedRevision = pendingConversation ? 0 : props.projection?.seq;
    if (expectedRevision === undefined) return false;
    const original = commandOptions.preserveDraft ? null : commandOptions.draftReceipt ?? captureWritingDraftReceipt(draftResources, captureAcknowledgment, draftResources.draft().text);
    let succeeded = false;
    const failureQueue = queue.acquireOwner();
    capturingSources.current = true; setCapturingCompaction(true);
    try {
      if (commandOptions.queued) {
        const inputId = commandOptions.queued.inputId;
        succeeded = await executeWritingQueuedCompaction({compaction, inputId, explicit: commandOptions.queued.explicit,
          conversationId: props.conversationId, manuscriptId: props.manuscriptId, current: () => !isRuntimeDisabled() && lifecycleRef.current === epoch,
          queueController: queue.controller,
          capture: async (nextRequestId, previousRequestId, expectedQueueRevision, userInput) => {
            await captureOwnerIntent?.(nextRequestId);
            if (isRuntimeDisabled() || lifecycleRef.current !== epoch) return false;
            return prepareQueuedWritingCompaction({host: props,
              selection: structuredClone(selection), requestId: nextRequestId, current: () => !isRuntimeDisabled() && lifecycleRef.current === epoch, ensureConversation, contribution,
              history: props.gateways?.history ?? agentSessionGateway, compaction, inputId, previousRequestId, expectedQueueRevision, userInput,
              onCaptured: () => { if (lifecycleRef.current === epoch) setCapturingCompaction(false); }});
          }});
        return succeeded;
      }
      if (compaction.isPending()) return false;
      if (!commandOptions.requestId) {
        await captureOwnerIntent?.(requestId);
        if (isRuntimeDisabled() || lifecycleRef.current !== epoch) return false;
      }
      succeeded = await prepareWritingCompaction({ host: props, selection: structuredClone(selection), requestId, expectedRevision,
        current: () => !isRuntimeDisabled() && lifecycleRef.current === epoch, ensureConversation, contribution,
        execute: request => { if (lifecycleRef.current === epoch) setCapturingCompaction(false); return compaction.execute(request, original?.acknowledge, original?.draftAcknowledgment); } });
      return succeeded;
    } catch (reason: unknown) { notify.error(aiAssistanceErrorMessage(reason)); return false; }
    finally {
      capturingSources.current = false;
      if (lifecycleRef.current === epoch) setCapturingCompaction(false);
      if (commandOptions.queued) await queue.controller.current?.reload();
      if (succeeded) failureQueue?.release();
      else try { await pauseRejectedSteerQueue(failureQueue); } catch { notify.error("无法确认后续队列是否暂停，请核对队列状态。"); }
    }
  }
  async function submit(text: string, options: WritingAgentSubmitOptions, queued?: { inputId: string; revision: number; autoDispatch?: boolean }, retrievalTraceId?: string,
    receipt: WritingDraftReceipt = queued ? unownedWritingDraftReceipt(text, options.userInput)
      : captureWritingDraftReceipt(draftResources, captureAcknowledgment, readComposerCommand(text) ? draftResources.draft().text.trim() : text), submissionRequestId?: string): Promise<void> {
    if (isRuntimeDisabled()) return;
    const cancelEpoch = sendCancellationEpoch.current, originalController = controller.current;
    const token = queued ? Symbol("queue dispatch") : undefined;
    if (queued && token) {
      activeOwnerRequest.current = null;
      activeQueueDispatchRef.current = token;
      setActiveQueueDispatch({inputId: queued.inputId, token});
    }
    try {
      if (!submissionRequestId && !readComposerCommand(text) && props.conversationId && getNativePreviewCapabilities(runtime)?.supportsOwnerIntent) {
        submissionRequestId = crypto.randomUUID();
        try { await freezeNewPreviewOwnerIntent(runtime, props.conversationId, submissionRequestId); }
        catch (cause) { notify.error(`无法保存预览请求归属，请重试。（${cause instanceof Error ? cause.message : "agent_preview_owner_intent_failed"}）`); return; }
      }
      if (isRuntimeDisabled() || cancelEpoch !== sendCancellationEpoch.current || controller.current !== originalController) return;
      await submitRequest(text, options, queued, retrievalTraceId, receipt, submissionRequestId);
    }
    finally {
      if (token && activeQueueDispatchRef.current === token) {
        activeQueueDispatchRef.current = null;
        setActiveQueueDispatch(current => current?.token === token ? null : current);
      }
    }
  }
  async function submitRequest(text: string, options: WritingAgentSubmitOptions, queued: { inputId: string; revision: number; autoDispatch?: boolean } | undefined, retrievalTraceId: string | undefined,
    receipt: WritingDraftReceipt, submissionRequestId?: string): Promise<void> {
    const owner = controller.current;
    const cancelEpoch = sendCancellationEpoch.current;
    const currentSubmission = () => cancelEpoch === sendCancellationEpoch.current && controller.current === owner;
    const submissionQueue = queue.controller.current;
    let confirmedQueueSnapshot = submissionQueue?.getSnapshot();
    let queueReadConfirmed = false;
    const preparationDraft = receipt.draft;
    if (isRuntimeDisabled() || props.hostFailure || toolRecoveryBlocked || handoffBlocked || steering.unresolved || queueUnresolved || !props.manuscriptId || !props.conversationId || !owner) return;
    if (!queued && await submissionFeedback.retryUncertain(text)) return;
    if (isRuntimeDisabled() || !currentSubmission()) return;
    if (readComposerCommand(text)) {
      if (queued) await dispatchQueuedAgentCommand({inputId: queued.inputId, text, running,
        executeQueued: () => commands.compact(text, {preserveDraft: true, queued: {inputId: queued.inputId, explicit: false}})});
      else if (!running) { lastSubmitOptions.current = options; await compact(text, {draftReceipt: receipt}); }
      return;
    }
    if (commands.pending) return;
    if (!pendingConversation && props.historyReady && !queued && text.trim()
      && metadataSend.wait([text, structuredClone({...options, userInput: options.userInput ?? draftResources.input(text)}), queued, retrievalTraceId, receipt, submissionRequestId])) return;
    if (!queueReady && !pendingConversation) return;
    options = {...options, userInput: options.userInput ?? draftResources.input(text)};
    lastSubmitOptions.current = options;
    if (options.includeConceptRetrieval && retrievalTraceId === undefined) {
      const epoch = ++retrievalEpoch.current;
      const requestId = globalThis.crypto.randomUUID();
      const retrievalOwner = retrievalOwnerRef.current;
      retrievalRequestId.current = requestId;
      retrievalQueued.current = queued;
      const pending = { text, requestId, options, receipt, ...(submissionRequestId ? {submissionRequestId} : {}), ...(queued === undefined ? {} : { queued }), isLoading: true } satisfies WritingPendingRetrieval;
      if (retrievalOwner) setWritingRetrievalOwner(retrievalOwner, pending);
      else setPendingRetrieval(pending);
      try {
        const preview = await aiGateway.previewConceptRetrieval({ clientRequestId: requestId, query: text });
        if (retrievalEpoch.current !== epoch || (retrievalOwner
          ? retrievalOwner.pending?.requestId !== requestId
          : retrievalRequestId.current !== requestId)) return;
        retrievalRequestId.current = undefined;
        const resolved = { text, requestId, options, receipt, ...(submissionRequestId ? {submissionRequestId} : {}), ...(queued === undefined ? {} : { queued }), preview, isLoading: false } satisfies WritingPendingRetrieval;
        if (retrievalOwner) setWritingRetrievalOwner(retrievalOwner, resolved);
        else setPendingRetrieval(resolved);
      } catch (reason: unknown) {
        if (retrievalEpoch.current !== epoch || (retrievalOwner
          ? retrievalOwner.pending?.requestId !== requestId
          : retrievalRequestId.current !== requestId)) return;
        retrievalRequestId.current = undefined;
        if (retrievalOwner) setWritingRetrievalOwner(retrievalOwner, undefined);
        else setPendingRetrieval(undefined);
        notify.error(aiAssistanceErrorMessage(reason));
      }
      return;
    }
    if (!(await ensureConversation())) return;
    if (isRuntimeDisabled() || !currentSubmission()) return;
    if (pendingConversation) {
      metadataSend.wait([text, structuredClone(options), queued, retrievalTraceId, receipt, submissionRequestId], true);
      return;
    }
    const retrievalOwner = retrievalOwnerRef.current;
    if (retrievalOwner) setWritingRetrievalOwner(retrievalOwner, undefined);
    else setPendingRetrieval(undefined);
    retrievalQueued.current = undefined;
    if (state?.phase === "started" && state.outcome) owner.dismiss();
    let sources: ReturnType<typeof captureWritingSubmissionSources>;
    if (capturingSources.current) return;
    const capture = Symbol("submission source capture");
    captureOwner.current = capture;
    capturingSources.current = true;
    try {
      const captureLifecycle = lifecycleRef.current;
      const fileBuffers = await props.readFileBuffers?.();
      if (isRuntimeDisabled() || lifecycleRef.current !== captureLifecycle || !currentSubmission()) return;
      sources = captureWritingSubmissionSources({ manuscriptId: props.manuscriptId, files: props.files, contextScope: props.activePath ? "current-file" : "manuscript",
        activePath: props.activePath, content: props.content, contentHash: props.contentHash,
        referencedPaths: options.userInput?.flatMap(input => input.type === "mention" && input.target.kind === "file" && !input.target.sourceId.startsWith("context:") ? [input.target.resourceId] : []),
        editor: props.readEditorSnapshot?.() ?? null, fileBuffers });
    } catch (reason) { if (currentSubmission()) notify.error(reason instanceof Error ? reason.message : "无法读取当前文件缓冲区，请稍后重试。"); return; }
    finally { if (captureOwner.current === capture) {captureOwner.current = null; capturingSources.current = false;} }
    const requestId = submissionRequestId ?? crypto.randomUUID();
    let resources: ReturnType<typeof contribution.selected>;
    try {if (!contribution.ready) throw new Error("上下文读取中"); await contribution.flush(); if (isRuntimeDisabled() || !currentSubmission()) return; resources = contribution.selected(options.userInput, requestId);} catch {if (currentSubmission()) notify.error("无法核对推荐上下文，请重试。");return;}
    const request = { conversationId: props.conversationId, requestId, text, userInput: options.userInput ?? [],
      resources, context: { manuscriptId: props.manuscriptId, files: sources.contextFiles }, ...(options.modelSelection ? { model: options.modelSelection } : {}),
      ...(retrievalTraceId === undefined ? {} : { retrieval: { traceId: retrievalTraceId, query: text } }),
    };
    frozenWorkspace.current = { requestId: request.requestId, buffers: sources.buffers, draft: preparationDraft };
    const preparationLifecycle = lifecycleRef.current;
    activeOwnerRequest.current = requestId;
    if (queued) await owner.prepareQueued(request, queued.inputId, queued.revision, receipt.acknowledge, sources.buffers, receipt.draftAcknowledgment);
    else await owner.prepare(request, receipt.acknowledge, sources.buffers, receipt.draftAcknowledgment);
    if (!currentSubmission()) return;
    const prepared = owner.getSnapshot();
    if (prepared.error === "prepare" && !queued && !owner.hasWritingPreparation()) {
      owner.dismiss();
      frozenWorkspace.current = null;
      recoverAgentPreparationFailure({text, userInput: request.userInput, originalDraft: preparationDraft, read: draftResources.draft,
        restore: value => draftResources.restore(value.text, request.userInput),
        notifyFailure: lifecycleRef.current === preparationLifecycle});
      return;
    }
    const preparedMode = prepared.preview
      ? executionModeForModel(prepared.preview.input.model, prepared.preview.input.reasoningEffort)
      : null;
    if (isRuntimeDisabled()) return;
    // Every submission, including a queued one, gets an isolated editable
    // copy before it can be started. A queue item produced during an active
    // turn continues automatically once that turn ends; an idle queue follows
    // the same automatic FIFO path.
    if (prepared.phase === "preview" && prepared.preview && preparedMode !== null
      && !(await prepareEditableWorkspace(prepared.preview, {owner, buffers: sources.buffers}))) return;
    if (isRuntimeDisabled() || !currentSubmission()) return;
    if (prepared.preview && !owner.isOriginalPreviewCurrent(prepared.preview)) return;
    if ((!queued || queued.autoDispatch === true) && (!options.includeConceptRetrieval || retrievalTraceId !== undefined)) {
      if (prepared.phase === "preview" && prepared.preview && preparedMode !== null) {
        await owner.confirm(preparedMode, props.onSubmissionAdmitted);
        const previousReadSequence = submissionQueue?.getSnapshot().readSequence ?? 0;
        await submissionQueue?.reload();
        confirmedQueueSnapshot = submissionQueue?.getSnapshot();
        queueReadConfirmed = !!confirmedQueueSnapshot?.queue && !confirmedQueueSnapshot.loading && !confirmedQueueSnapshot.error
          && !confirmedQueueSnapshot.uncertain && (confirmedQueueSnapshot.readSequence ?? 0) > previousReadSequence;
        const admitted = owner.getSnapshot().admission;
        const originalAdmitted = admitted?.requestId === prepared.preview.requestId && admitted.conversationId === prepared.preview.conversationId
          && admitted.turnId === prepared.preview.turnId;
        if (!isRuntimeDisabled() && !queued && originalAdmitted && submissionQueue?.getSnapshot().queue?.paused) {
          // A stopped or recovered turn pauses the durable queue. Starting a
          // new ordinary turn is the user's explicit continuation signal.
          await submissionQueue?.edit({ type: "resume" });
        }
        if (originalAdmitted && (props.conversationTitle === undefined || props.conversationTitle === "新对话")
          && props.messages.length === 0 && (props.projection?.turnOrder.length ?? 0) === 0) {
          void nameInitialConversation(props.conversationId, prepared.preview.requestId, text, {
            catalog: props.gateways?.catalog ?? agentCatalogGateway,
            metadata: props.gateways?.metadata ?? agentMetadataGateway,
          }).then(row => {
            if (!row || lifecycleRef.current !== preparationLifecycle) return;
            if (currentTitle.current && currentTitle.current !== "新对话" && currentTitle.current !== row.title) props.onRetryMetadata?.();
            else props.onConversationTitleChanged?.(row);
          }).catch(() => { if (lifecycleRef.current === preparationLifecycle) notify.error("消息已发送，但自动命名尚待核对；请核对原改名操作。"); });
        }
      }
    }
    // The post-confirmation read already covers this path when neither the
    // owner nor its snapshot changed. Other branches and intervening edits
    // still need the final reconciliation.
    if (!queueReadConfirmed || queue.controller.current !== submissionQueue || submissionQueue?.getSnapshot() !== confirmedQueueSnapshot)
      await queue.controller.current?.reload();
  }
  function submitFromComposer(text: string, options: WritingAgentSubmitOptions): void | false {
    if (isRuntimeDisabled() || !props.conversationId) return false;
    if (readComposerCommand(text)) {void submit(text, options); return false;}
    // Metadata reconciliation happens before the queue readiness check in
    // submitRequest; allow it to start without permitting an actual send.
    const canCheckMetadata = props.historyReady && !props.hostFailure && !props.archived && (!!metadataIssue || !!props.metadataLoading);
    if (sendingSubmissionRef.current || toolRecoveryBlocked || handoffBlocked || steering.unresolved || queueUnresolved
      || !props.manuscriptId || !controller.current || commands.pending || !queueReady && !pendingConversation && !canCheckMetadata) return false;
    activeOwnerRequest.current = null;
    const submissionId = crypto.randomUUID(); activeSubmissionId.current = submissionId;
    previousSubmissionRequest.current = controller.current?.getSnapshot().request?.requestId ?? null;
    sendingSubmissionRef.current = true; setSendingSubmission(true);
    setPendingSubmission({id: submissionId, conversationId: props.conversationId, text,
      ...(options.userInput === undefined ? {} : {userInput: structuredClone(options.userInput)})});
    void submit(text, options).finally(() => {if (activeSubmissionId.current === submissionId) {sendingSubmissionRef.current = false; setSendingSubmission(false);}});
  }
  async function pauseCanceledQueueInput(inputId: string): Promise<void> {
    const owner = queue.controller.current;
    if (!owner) throw new Error("QUEUE_CANCEL_OWNER_UNAVAILABLE");
    if (owner.getPendingRequest() && !await owner.retry()) throw new Error("QUEUE_CANCEL_PAUSE_UNCONFIRMED");
    await owner.reload();
    const current = owner.getSnapshot();
    if (queue.controller.current !== owner || !current.queue || current.loading || current.editing || current.uncertain || current.error)
      throw new Error("QUEUE_CANCEL_READ_UNAVAILABLE");
    const input = current.queue.inputs.find(item => item.inputId === inputId);
    if (!input || input.paused) return;
    if (current.queue.preparingInputId === inputId || !await owner.edit({type:"pauseInput", inputId}))
      throw new Error("QUEUE_CANCEL_PAUSE_UNCONFIRMED");
    // A recovered edit receipt can acknowledge the operation without carrying
    // the queue snapshot. Only a subsequent authoritative read proves the hold.
    await owner.reload();
    const confirmed = owner.getSnapshot();
    if (queue.controller.current !== owner || !confirmed.queue || confirmed.loading || confirmed.editing || confirmed.uncertain || confirmed.error
      || confirmed.queue.inputs.some(item => item.inputId === inputId && !item.paused)) throw new Error("QUEUE_CANCEL_PAUSE_UNCONFIRMED");
  }
  function sendStopFailureMessage(reason: unknown, requestId?: string | null, inputId?: string | null): string {
    const safe = diagnosticError(reason);
    const internalCode = reason instanceof Error && /^[A-Z0-9_]+$/.test(reason.message) ? reason.message : undefined;
    const code = typeof safe.code === "string" ? safe.code : internalCode ?? "SEND_CANCEL_UNCONFIRMED";
    const fields = [`code=${code}`, ...(props.conversationId ? [`C=${props.conversationId}`] : []),
      ...(requestId ? [`R=${requestId}`] : []), ...(inputId ? [`I=${inputId}`] : []),
      ...(typeof safe.httpStatus === "number" ? [`http=${safe.httpStatus}`] : []), ...(typeof safe.cause === "string" ? [`cause=${safe.cause}`] : [])];
    return `无法确认发送已停止，原消息已保留，请核对后重试。 [${fields.join("；")}]`;
  }
  async function retryQueueStopHold(): Promise<void> {
    const owner = controller.current;
    if (cancelSendingPending || !owner || !props.manuscriptId || !props.conversationId) return;
    const scope = {manuscriptId:props.manuscriptId,conversationId:props.conversationId};
    setCancelSendingPending(true);
    try {
      if (!await owner.retryQueueStopHold(scope)) throw new Error("QUEUE_CANCEL_HOLD_UNAVAILABLE");
      const held = owner.getSnapshot().heldQueueInputId;
      if (held) {
        await pauseCanceledQueueInput(held);
        if (!await owner.clearQueueInputHold(scope,held)) throw new Error("QUEUE_CANCEL_HOLD_UNCONFIRMED");
      }
      setQueueStopFailure(null);setSendStopFailure(null);
    } catch (reason) {setSendStopFailure(sendStopFailureMessage(reason,null,queueStopFailure ?? owner.getSnapshot().heldQueueInputId));}
    finally {setCancelSendingPending(false);}
  }
  async function retrySendStopIntent(): Promise<void> {
    const owner = controller.current;
    if (cancelSendingPending || !owner || !props.manuscriptId || !props.conversationId) return;
    setCancelSendingPending(true);
    try {
      if (!await owner.retrySendStopIntent({manuscriptId:props.manuscriptId,conversationId:props.conversationId}))
        throw new Error("SEND_CANCEL_INTENT_UNAVAILABLE");
      setSendStopFailure(null);
    } catch (reason) {setSendStopFailure(sendStopFailureMessage(reason,activeOwnerRequest.current));}
    finally {setCancelSendingPending(false);}
  }
  async function cancelSending(): Promise<void> {
    if (cancelSendingPending) return;
    const owner = controller.current;
    const heldInputId = queueStopFailure ?? state?.heldQueueInputId ?? null;
    const recoveredRequestId = state?.writingPreparation?.intent?.requestId ?? state?.preparation?.intent?.submission.requestId
      ?? state?.startRecovery?.intent?.start.requestId ?? null;
    const requestId = heldInputId ? null : activeOwnerRequest.current
      ?? (!activeQueueDispatch && pendingSubmission?.id === recoveredRequestId ? recoveredRequestId : null);
    const inputId = activeQueueDispatch?.inputId ?? heldInputId;
    const snapshot = owner?.getSnapshot();
    const ownedRequest = snapshot?.writingPreparation?.intent?.requestId ?? snapshot?.preparation?.intent?.submission.requestId
      ?? snapshot?.startRecovery?.intent?.start.requestId ?? snapshot?.request?.requestId;
    sendCancellationEpoch.current += 1;
    metadataSend.cancel();
    if (pendingRetrieval) cancelRetrieval();
    if (captureOwner.current) {captureOwner.current = null; capturingSources.current = false;}
    setCancelSendingPending(true);
    setSendStopFailure(null);
    try {
      if (owner && requestId && ownedRequest === requestId) {
        cancelledOwnerSubmission.current = {requestId, submissionId: activeSubmissionId.current};
        if (!await owner.cancelPendingSend(requestId)) throw new Error("SEND_CANCEL_IDENTITY_MISMATCH");
      } else {
        if (inputId) {
          if (!owner || !props.manuscriptId || !props.conversationId) throw new Error("QUEUE_CANCEL_OWNER_UNAVAILABLE");
          const scope = {manuscriptId:props.manuscriptId,conversationId:props.conversationId};
          setQueueStopFailure(inputId);
          await owner.holdQueueInput(scope, inputId);
          await pauseCanceledQueueInput(inputId);
          if (!await owner.clearQueueInputHold(scope, inputId)) throw new Error("QUEUE_CANCEL_HOLD_UNCONFIRMED");
          setQueueStopFailure(null);
        }
        activeSubmissionId.current = null; sendingSubmissionRef.current = false; setSendingSubmission(false);
        setPendingSubmission(null);
      }
    } catch (reason) {
      if (inputId && !requestId) setQueueStopFailure(inputId);
      setSendStopFailure(sendStopFailureMessage(reason,requestId,inputId));
    } finally {
      if (activeQueueDispatch && !requestId && activeQueueDispatchRef.current === activeQueueDispatch.token) {
        activeQueueDispatchRef.current = null; setActiveQueueDispatch(null);
      }
      setCancelSendingPending(false);
    }
  }
  function cancelRetrieval(): void {
    retrievalEpoch.current += 1;
    retrievalQueued.current = undefined;
    const retrievalOwner = retrievalOwnerRef.current;
    const ownerPending = retrievalOwner?.pending;
    const requestId = ownerPending?.requestId ?? retrievalRequestId.current;
    retrievalRequestId.current = undefined;
    if (requestId !== undefined) void aiGateway.cancelConceptRetrievalPreview(requestId).catch(() => undefined);
    if (retrievalOwner) setWritingRetrievalOwner(retrievalOwner, undefined);
    else setPendingRetrieval(undefined);
  }
  function confirmRetrieval(): void {
    if (isRuntimeDisabled()) return;
    const retrievalOwner = retrievalOwnerRef.current;
    const pending = retrievalOwner?.pending ?? pendingRetrieval;
    const options = pending?.options ?? lastSubmitOptions.current;
    if (!pending?.preview || !options) return;
    const traceId = pending.preview.traceId;
    const queued = pending.queued ?? retrievalQueued.current;
    if (!pending.submissionRequestId && getNativePreviewCapabilities(runtime)?.supportsOwnerIntent) {
      notify.error("预览请求归属未确认，原草稿已保留。（agent_preview_owner_intent_missing）"); return;
    }
    cancelRetrieval();
    void submit(pending.text, options, queued, traceId, pending.receipt ?? unownedWritingDraftReceipt(pending.text, options.userInput), pending.submissionRequestId);
  }
  async function addToQueue(text: string, userInput: readonly AgentUserInput[] = draftResources.input(text), originalDraft = text): Promise<void> {
    if (isRuntimeDisabled()) return;
    if(handoffInputBlocked || (handoffBlocked && !!draftResources.draft().queuePlacement) || steering.unresolved || (!pendingConversation && !contribution.ready))return;
    if (!queueReady) return;
    const value = queue.controller.current;
    const current = value?.getSnapshot().queue;
    if (!current) return;
    const applied = await value.edit(queueDraftEdit(draftResources.draft(), current, text, userInput), captureAcknowledgment(originalDraft), undefined, undefined, isRuntimeDisabled);
    if (applied) autoPrepare.markQueued();
  }
  resumeMetadataSend.current = async (...request) => {
    if (isRuntimeDisabled() || handoffInputBlocked) return;
    if (!pendingConversation && !contribution.ready) { notify.error("上下文尚未就绪，消息已保留，请核对后重新发送。"); return; }
    // A turn may still be running when background metadata becomes ready.
    // Preserve the composer send action as steering into that active turn.
    if (steeringTurn && !request[2]) {
      await steering.submit(request[0], { userInput: request[1].userInput ?? draftResources.input(request[0]) });
    } else await submit(...request);
  };
  async function steerQueued(inputId: string, text: string): Promise<boolean> {
    if (isRuntimeDisabled()) return false;
    if (toolRecoveryBlocked || handoffInputBlocked || (!pendingConversation && !contribution.ready) || commands.pending || !queueReady || steering.unresolved || manualQueueDispatch.current) return false;
    const queuedCommand = readComposerCommand(text);
    if (queuedCommand && running) return await dispatchQueuedAgentCommand({inputId, text, running: true}) ?? false;
    if (!steeringTurn) {
      const value = queue.controller.current, options = lastSubmitOptions.current;
      const snapshot = value?.getSnapshot(), current = snapshot?.queue;
      const input = current?.inputs.find(item => item.inputId === inputId);
      if (!value || !options || !current || !input || pending
        || snapshot.loading || snapshot.editing || snapshot.uncertain || current.preparingInputId) return false;
      const lifecycle = lifecycleRef.current;
      const live = () => lifecycleRef.current === lifecycle;
      manualQueueDispatch.current = true;
      setDispatchingQueue(true);
      try {
        // Explicit dispatch takes priority over automatic FIFO. Keep the other
        // items in order and use the durable queue admission to remove this
        // item only after its new turn is confirmed.
        if (current.inputs[0]?.inputId !== inputId
          && !(await value.edit({ type: "reorder", inputIds: [inputId, ...current.inputs.filter(item => item.inputId !== inputId).map(item => item.inputId)] }, undefined, undefined, undefined, isRuntimeDisabled))) return false;
        if (isRuntimeDisabled() || !live()) return false;
        const held = value.getSnapshot().queue;
        if ((held?.paused || held?.inputs.find(item => item.inputId === inputId)?.paused)
          && !(await value.edit({ type: "resumeInput", inputId }, undefined, undefined, undefined, isRuntimeDisabled))) return false;
        if (isRuntimeDisabled() || !live()) return false;
        const ready = value.getSnapshot().queue;
        if (!ready || ready.inputs[0]?.inputId !== inputId) return false;
        if (queuedCommand) return await dispatchQueuedAgentCommand({inputId, text, running: false,
          executeQueued: () => commands.compact(text, {preserveDraft: true, queued: {inputId, explicit: true}})}) ?? false;
        await submit(input.text, { ...options, userInput: input.userInput ?? [] }, { inputId, revision: ready.revision, autoDispatch: true });
        return controller.current?.getSnapshot().phase === "started";
      } finally {
        // Source capture may fail before a submission exists. Do not turn an
        // unsuccessful explicit click into an automatic retry of this item.
        const latest = value.getSnapshot();
        if (live() && retrievalQueued.current?.inputId !== inputId && !latest.editing && !latest.uncertain && !latest.queue?.preparingInputId
          && controller.current?.getSnapshot().phase === "idle" && !latest.queue?.paused) await value.edit({ type: "pause" });
        manualQueueDispatch.current = false;
        if (live()) setDispatchingQueue(false);
      }
    }
    const snapshot=queue.controller.current?.getSnapshot();
    if(!snapshot?.queue || snapshot.loading || snapshot.editing || snapshot.uncertain || snapshot.error)return false;
    return handoff.submit(snapshot.queue,steeringTurn,inputId);
  }
  async function recoverQueue(): Promise<void> {
    if (!props.manuscriptId || !props.conversationId) return;
    const inputId = queue.controller.current?.getSnapshot().queue?.preparingInputId;
    if (inputId && await recoverWritingQueueCompaction(compaction, {conversationId: props.conversationId, manuscriptId: props.manuscriptId}, inputId, queue.controller)) return;
    await controller.current?.recoverQueued({ manuscriptId: props.manuscriptId, conversationId: props.conversationId });
    const recovered = controller.current?.getSnapshot().preview;
    if (recovered) await prepareEditableWorkspace(recovered, {restore: true});
    await queue.controller.current?.reload();
  }
  function recoverDisplayedQueue(inputId: string): void {
    const current = queue.controller.current?.getSnapshot().queue;
    if (current?.preparingInputId !== inputId
      || writingQueuePreparingPresentation(inputId, controller.current?.getSnapshot() ?? null, activeQueueDispatch?.inputId) !== "recovery") return;
    void recoverQueue();
  }
  async function stop(): Promise<void> {
    if (compaction.isPending()) { await compaction.stop(); return; }
    if (state?.phase === "started" && !state.outcome) { await controller.current?.stop(); await queue.controller.current?.reload(); return; }
    if (!activeTurn || !props.conversationId) return;
    try { await turnsGateway.interrupt({ conversationId: props.conversationId, turnId: activeTurn }); }
    catch { notify.error("停止请求失败，请重试。"); }
    finally { await queue.controller.current?.reload(); }
  }
  useWritingQueuedStartRecovery({controller, acquireQueue: queue.acquireOwner, gateway: props.gateways?.queue.gateway ?? agentInputQueueGateway,
    onAdmitted: props.onSubmissionAdmitted});
  const submissionFeedback = useWritingSubmissionFeedback({state, controller, onAdmitted: props.onSubmissionAdmitted,
    observedTurn: !!state?.preview && !!props.projection?.turns.has(state.preview.turnId),
    draft: draftResources.draft, originalDraft: frozenWorkspace.current?.draft,
    restore: value => draftResources.restore(value.text, agentDraftInput(value)),
    prepareWorkspace: value => prepareEditableWorkspace(value, {restore: true, createMissing: true}),
    holdPreparation: (intent, eligible) => holdRejectedQueuePreparation(queue.acquireOwner(), intent, eligible),
    reload: async () => { await queue.controller.current?.reload(); }, recover: recoverQueue});
  async function openChildTask(conversationId: string): Promise<void> {
    if (!props.onOpenConversation || !props.manuscriptId) return;
    const epoch = lifecycleRef.current;
    try {
      const summary = await (props.gateways?.metadata ?? agentMetadataGateway).read({
        id: conversationId,
        binding: { kind: "manuscript", resourceId: props.manuscriptId },
      });
      if (lifecycleRef.current === epoch) props.onOpenConversation(summary);
    } catch {
      if (lifecycleRef.current === epoch) notify.error("读取子任务会话失败，请稍后重试。");
    }
  }
  async function reconcileChildTask(conversationId: string): Promise<void> {
    if (!props.conversationId) return;
    const epoch = lifecycleRef.current;
    try {
      const updated = await subtasksGateway.reconcile(props.conversationId, conversationId);
      if (lifecycleRef.current !== epoch) return;
      await reloadChildTasks();
      if (lifecycleRef.current !== epoch) return;
      notify.success(updated.status === "recovery_required" ? "仍没有可确认的终态，任务保持待恢复。" : "已核对子任务终态。");
    } catch {
      if (lifecycleRef.current === epoch) notify.error("无法核对子任务状态，请稍后重试。");
    }
  }
  async function resumeChildTask(conversationId: string): Promise<void> {
    if (isRuntimeDisabled() || !props.conversationId || !props.manuscriptId) return;
    const epoch = lifecycleRef.current;
    try {
      await subtasksGateway.resumeWriting(props.conversationId, conversationId, props.manuscriptId);
      if (lifecycleRef.current !== epoch) return;
      notify.success("已恢复子任务，正在继续执行。");
      await reloadChildTasks();
      if (lifecycleRef.current !== epoch) return;
    } catch (error) {
      if (lifecycleRef.current === epoch) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        const message = code === "recoveryRestoreUnavailable"
          ? "无法恢复子任务：冻结提交已失效。"
          : code === "recoveryAdmissionUnavailable"
            ? "无法恢复子任务：模型执行准入失败，请重新核对登录状态。"
            : code === "recoveryTrackingUnavailable"
              ? "无法恢复子任务：恢复后的运行状态无法登记。"
              : code === "recoveryParentBindingUnavailable"
                ? "无法恢复子任务：父对话已不再绑定当前稿件。"
                : code === "recoveryChildBindingUnavailable"
                  ? "无法恢复子任务：子对话已不再绑定当前稿件。"
                  : code === "recoveryTaskUnavailable"
                    ? "无法恢复子任务：持久化任务状态不可恢复。"
                    : code === "recoverySubmissionUnavailable"
                      ? "无法恢复子任务：冻结提交记录不可读取。"
                      : code === "recoveryContextUnavailable"
                        ? "无法恢复子任务：冻结上下文版本不一致。"
                        : code === "recoveryTurnUnavailable"
                          ? "无法恢复子任务：原执行轮次已没有可接管的活动状态。"
                          : code === "recoveryValidationUnavailable"
                            ? "无法恢复子任务：冻结输入与当前恢复请求不匹配。"
                            : code === "recoveryModelUnavailable"
                              ? "无法恢复子任务：当前模型凭据或传输不可用。"
                          : "无法恢复子任务：会话绑定或冻结提交已不可用。";
        notify.error(message);
      }
    }
  }
  const changes = useWritingTurnChangeScopes({ conversationId: props.conversationId, manuscriptId: props.manuscriptId,
    projection: props.projection, gateway: props.gateways?.review.workspaceReviewGateway ?? agentWorkspaceReviewGateway,
    fileSessions: props.fileSessions });
  const [changeReadErrors, setChangeReadErrors] = useState<ReadonlyMap<string, {scope: string; message: string; retry: () => void}>>(new Map());
  function updateChangeReadError(turnId: string, scope: AgentWorkspaceScope, error: {readonly message: string; readonly retry: () => void} | null): void {
    const identity = changeScopeKey(scope);
    setChangeReadErrors(previous => {
      if (!error && previous.get(turnId)?.scope !== identity) return previous;
      const next = new Map(previous);
      if (error) next.set(turnId, {scope: identity, ...error});
      else next.delete(turnId);
      return next;
    });
  }
  const visibleChangeReadErrors = [...changeReadErrors].filter(([turnId, error]) => {
    const scope = changes.scopes.get(turnId);
    return scope && changeScopeKey(scope) === error.scope && scope.conversationId === props.conversationId && scope.manuscriptId === props.manuscriptId;
  });
  const [visibleChangePaths, setVisibleChangePaths] = useState<ReadonlyMap<string, {scope: string; paths: readonly string[]}>>(new Map());
  function updateVisibleChangePaths(turnId: string, scope: AgentWorkspaceScope, paths: readonly string[]): void {
    const identity = changeScopeKey(scope);
    setVisibleChangePaths(previous => {
      const current = previous.get(turnId);
      if (!paths.length && current?.scope !== identity) return previous;
      if (current?.scope === identity && JSON.stringify(current.paths) === JSON.stringify(paths)) return previous;
      const next = new Map(previous);
      if (paths.length) next.set(turnId, {scope: identity, paths: [...paths]});
      else next.delete(turnId);
      return next;
    });
  }
  function turnAttachmentPaths(turnId: string): ReadonlySet<string> {
    const scope = changes.scopes.get(turnId), current = visibleChangePaths.get(turnId);
    if (!scope || !current || current.scope !== changeScopeKey(scope)) return new Set();
    return new Set(current.paths.flatMap(path => [path, `source://writings/${scope.manuscriptId}/${path}`]));
  }
  function turnAttachment(turnId: string): React.JSX.Element | null {
    const scope = changes.scopes.get(turnId);
    if (!scope) return null;
    return <WritingWorkspaceChangeSummary key={`diff:${changeScopeKey(scope)}`} scope={scope}
      {...(changes.publishedProposals.get(turnId) ? {publishedProposalId: changes.publishedProposals.get(turnId)!} : {})}
      onAvailablePathsChange={paths => updateVisibleChangePaths(turnId, scope, paths)}
      onReadErrorChange={error => updateChangeReadError(turnId, scope, error)}
      delivery={props.fileDeliveries?.find(entry => entry.turnId === turnId && entry.scope.requestId === scope.requestId)}
      {...(props.activePath === undefined ? {} : { activePath: props.activePath })} {...(props.fileSessions === undefined ? {} : { fileSessions: props.fileSessions })} {...(props.onJumpToEditor === undefined ? {} : { onJumpToEditor: props.onJumpToEditor })}
      {...props.gateways?.review} {...(props.undoProposal ? { undoProposal: props.undoProposal } : {})}
      disabled={running || pending || !!metadataIssue || !!props.archived} label="查看 diff" showManageCopy={false} />;
  }
  const forkActions = useConversationForkActions({ parentId: props.conversationId,
    binding: props.manuscriptId ? { kind: "manuscript", resourceId: props.manuscriptId } : null,
    projection: props.projection, disabled: pendingConversation || !props.historyReady || !!props.historyError || !!props.metadataUnavailable || !!props.metadataLoading,
    onOpen: props.onOpenConversation, ...(props.gateways ? { gateway: props.gateways.fork, metadata: props.gateways.metadata } : {}) });
  const inspectMessage = useCallback(async (message: WritingAgentMessage, options?: { readonly referencesOnly: true }) => {
    const [turnId, itemId] = message.id.split("/");
    if (!props.conversationId || !turnId || !itemId || !message.rawData) return null;
    return (props.gateways?.messageInspection ?? readMessageInspection)({ conversationId: props.conversationId, turnId, itemId, ...options });
  }, [props.conversationId, props.gateways?.messageInspection]);
  return <WritingAgentPanel {...(props.conversationId ? {approvalConversationId:props.conversationId} : {})} {...(contextUsage ? {contextUsage} : {})} headerControls={props.headerControls} showLauncher={props.showLauncher} dismissOnOutsideClick={props.dismissOnOutsideClick} readMessageData={inspectMessage} contextControls={contribution.controls} resourceGateways={contribution.resources} {...(props.gateways ? { modelGateway: props.gateways.model } : {})} {...forkActions} searchTarget={props.searchTarget} historyReady={props.historyReady} historyError={props.historyError} onDraftChange={setDraft} messages={recoveryMessages} hasPendingSubmission={!!pendingSubmission && !hasConfirmedSubmissionMessage(pendingSubmission, visibleMessages)} childTasks={childTasks} {...(props.onOpenConversation ? { onOpenChildTask: (id: string) => void openChildTask(id) } : {})} onReconcileChildTask={(id) => void reconcileChildTask(id)} onResumeChildTask={(id) => void resumeChildTask(id)} open={props.open}
    turnAttachment={turnAttachment} turnAttachmentPaths={turnAttachmentPaths}
    turnFeedback={turnId => {const error = visibleChangeReadErrors.find(([id]) => id === turnId)?.[1]; return error ? <AgentTransientFailure key={error.scope} id={`writing-change-${turnId}`} content={error.message} retry={error.retry} /> : null;}}
    suppressPreparing={!!props.hostFailure}
    inputDisabled={runtimeDisabled || !!props.hostFailure || !!props.archived || stoppingSubmission || visibleSubmissionSending || waitingForMetadata || capturingCompaction || (!compaction.state?.outcome && (compaction.state?.phase === "preparing" || compaction.state?.phase === "starting")) || state?.phase === "preparing" || state?.phase === "starting"}
    isSubmitting={stoppingSubmission || visibleSubmissionSending || waitingForMetadata || capturingCompaction || (!compaction.state?.outcome && (compaction.state?.phase === "preparing" || compaction.state?.phase === "starting")) || state?.phase === "preparing" || state?.phase === "starting"}
    submittingText={stoppingSubmission ? "正在停止发送……" : waitingForMetadata ? "正在核对对话状态……" : "正在核对请求……"}
    {...(canCancelSubmission ? {onCancelSending: () => void cancelSending(), cancelSendingPending: stoppingSubmission} : {})}
    {...(!stoppingSubmission && !sendStopNeedsRecovery && (queuePreparingStatus === "sending" || queuePreparingStatus === "recovery") && queuePreparingInputId ? {queuePreparation: {
      status: queuePreparingStatus, onRecover: () => recoverDisplayedQueue(queuePreparingInputId), recoveryDisabled: queueRecoveryDisabled,
    }} : {})}
    {...(props.gateways?.commands ? { commandGateway: props.gateways.commands } : {})}
    commandExecution={commands} onQueueCommand={(text, original) => void addToQueue(text, [], original)} onSubmitCommand={(text, options) => void submit(text, options)}
    historyHeader={!pendingConversation && props.conversationId && props.manuscriptId && props.onOpenConversation && props.historyReady && !props.historyError ? <ConversationForkOrigin
      key={`${props.manuscriptId}:${props.conversationId}`} conversationId={props.conversationId}
      binding={{ kind: "manuscript", resourceId: props.manuscriptId }} onOpen={props.onOpenConversation} {...(props.gateways ? { gateway: props.gateways.forkOrigin } : {})} /> : null}
    onModelSelectionChange={value=>{externalModel.current=value;setContextModel(value);}} onOpenChange={props.onOpenChange} onSubmit={submitFromComposer} onCancel={() => void stop()}
    isRunning={running} activeTaskKind={activeTaskKind} {...(activeTurnStartedAtMs === undefined ? {} : { thinkingStartedAtMs: activeTurnStartedAtMs })} submissionControls={() => <><AgentPendingSubmissionBubble pending={pendingSubmission} messages={visibleMessages} resourceGateways={contribution.resources}/>{props.conversationId && <AgentPendingSteeringBubbles messages={visibleMessages} conversationId={props.conversationId} orderKey={JSON.stringify([props.manuscriptId,props.conversationId])} direct={steering.state.awaitingHistory} handoffs={[...(handoff.state?.items.map(item=>item.intent)??[]),...(handoff.state?.intent?[handoff.state.intent]:[])]} resourceGateways={contribution.resources}/>} {submissionFeedback.ownerRecovery && <AgentRecoveryMessage id="preview-owner-recovery" label="原请求归属恢复" content="原请求的归属尚无法确认，原请求和草稿已保留。" diagnosticText={submissionFeedback.ownerRecovery.message}><div className="agent-failure-actions">{submissionFeedback.ownerRecovery.actions.map(action=><button key={action.id} type="button" onClick={()=>{void action.onClick();}}>{action.label}</button>)}</div></AgentRecoveryMessage>} {(sendStopFailure || (!!state?.heldQueueInputId || !!state?.queueStopHoldUnavailable || !!state?.sendStopIntentUnavailable || sendStopNeedsRecovery) && !cancelSendingPending) && <AgentTransientFailure id="send-cancel-unconfirmed" content={sendStopFailure ?? `无法确认发送已停止，原消息已保留，请核对后重试。 [code=SEND_CANCEL_UNCONFIRMED${props.conversationId ? `；C=${props.conversationId}` : ""}${state?.heldQueueInputId ? `；I=${state.heldQueueInputId}` : ""}${(state?.writingPreparation?.intent?.requestId ?? state?.startRecovery?.intent?.start.requestId ?? state?.preparation?.intent?.submission.requestId) ? `；R=${state?.writingPreparation?.intent?.requestId ?? state?.startRecovery?.intent?.start.requestId ?? state?.preparation?.intent?.submission.requestId}` : ""}]`} retry={() => {if (queueStopFailure || state?.heldQueueInputId || state?.queueStopHoldUnavailable) void retryQueueStopHold(); else if (state?.sendStopIntentUnavailable || state?.cancelSendRequested || state?.sendStopFailed) void retrySendStopIntent(); else void cancelSending();}}/>} {contribution.recovery}{toolRecoveryBlocked && props.projection?.conversationId !== props.conversationId && <AgentRecoveryMessage id="tool-recovery" label="工具操作恢复" content="工具操作尚待核对，请勿重复提交。"/>}
      {props.hostFailure && <AgentRecoveryMessage id="writing-host-load" label="稿件读取失败" content={props.hostFailure.content} diagnosticText={props.hostFailure.diagnosticText}
        {...(props.hostFailure.retry ? {retry: {label: "重新读取", onClick: props.hostFailure.retry}} : {})}/>}
      {changes.error && <AgentTransientFailure id="writing-change-history" content={changes.error} retry={changes.retry} />}
      {handoffNeedsAttention && queueReady && <AgentSteeringHandoffRecovery available={handoff.available} state={handoff.state} disabled={!props.historyReady || !!props.archived} canRetry={!!handoff.state?.intent && props.projection?.activeTurn === handoff.state.intent.turnId} queueContainsInput={!!queue.state?.queue?.inputs.some(input => input.inputId === handoff.state?.intent?.queueInputId || handoff.state?.items.some(item => item.intent.queueInputId === input.inputId))} onCheck={() => void handoff.refresh()} onRetry={() => void handoff.retry()}/>}
      <ConversationCreationRecovery {...creation} captureAdoption={captureAdoption} onFinished={creationFinished}/><WritingCompactionFeedback {...compaction}/>{pendingRetrieval && <PaperConceptRetrievalControl checked disabled pending={pendingRetrieval} onCancel={cancelRetrieval} onChange={() => undefined} onConfirm={confirmRetrieval} />}{props.archived && <p role="status">此对话已归档。历史和草稿保留，恢复后可继续。</p>}<AgentSteeringReceipt hidePendingMessages awaitingHistory={steering.state.awaitingHistory} transferFailures={steering.state.transferFailures} onRetryTransfer={id=>void reconcileSteeringTransfer(queue.controller.current,id,steering.retryConfirmation)} uncertain={steering.uncertain} pending={steering.pending} text={steering.state.request?.text} status={steering.status} {...(steering.state.request?.inputId ? { requestId: steering.state.request.inputId } : {})} disabled={!props.historyReady||!!metadataIssue||!!props.archived} onRetry={()=>void steering.retry()}/></>}
    composerAccessory={showQueue || props.taskGoal ? (options) => { lastSubmitOptions.current = options; return <WritingAgentTaskStack {...(props.taskGoal?{goal:props.taskGoal}:{})} {...(showQueue && queue.state ? {queue:{
      state: queue.state, hiddenInputIds:hiddenHandoffInputs, preparingStatus:queuePreparingStatus, compaction: commands.pending && compactRequestId && props.conversationId ? { id: compactRequestId, conversationId: props.conversationId, requestId: compactRequestId, inputId: compaction.queuedInputId, state: "pending" } : undefined, disabled: runtimeDisabled || handoffBlocked || (!pendingConversation && !contribution.ready) || !!steering.state.awaitingHistory?.length || dispatchingQueue || !queueReady || (submissionPending && !running) || steering.unresolved,
      ...(steeringTurn ? {steerDisabled:runtimeDisabled || toolRecoveryBlocked || handoffInputBlocked || !handoff.canSubmit(steeringTurn) || (!pendingConversation && !contribution.ready) || commands.pending || !queueReady || dispatchingQueue || steering.unresolved || !!state?.stopRequested} : {}), onEdit: (edit) => isRuntimeDisabled() ? Promise.resolve(false) : queue.controller.current?.edit(edit, undefined, undefined, undefined, isRuntimeDisabled) ?? Promise.resolve(false),
      onEditInComposer: (input, index, current) => {
        if (isRuntimeDisabled()) return Promise.resolve(false);
        draftResources.restoreQueue(input, index, current);
        return queue.controller.current?.edit({type: "remove", inputId: input.inputId}, undefined, undefined, undefined, isRuntimeDisabled) ?? Promise.resolve(false);
      },
      onReload: () => queue.controller.current?.reload(), onRetry: () => void queue.controller.current?.retry(),
      onSteer: (inputId: string, text: string) => steerQueued(inputId, text), steerStartsTurn: !steeringTurn && !commands.pending,
    }} : {})} />; } : undefined}
    draftResources={draftResources}
    {...(props.manuscriptId && props.conversationId ? {resourceScope: {kind: "manuscript" as const, resourceId: props.manuscriptId, conversationId: props.conversationId}} : {})}
    queueDraftEditing={!!draftResources.draft().queuePlacement}
    onQueue={(text, userInput) => void addToQueue(text, userInput)} queueDisabled={runtimeDisabled || handoffInputBlocked||(handoffBlocked && !!draftResources.draft().queuePlacement)||(!pendingConversation && !contribution.ready)||!queueReady||steering.unresolved||!queue.state?.queue || !!queue.state.loading || !!queue.state.editing || !!queue.state.uncertain || (submissionPending && !running) || (!!draftResources.draft().queuePlacement && !!queue.state?.queue?.preparingInputId)}
    {...(!runtimeDisabled && !handoffInputBlocked && steeringTurn && contribution.ready && !commands.pending && (queueReady || props.metadataLoading) && !queueUnresolved && !state?.stopRequested ? { onSteer: (text: string, userInput?: readonly AgentUserInput[]) => {
      if (isRuntimeDisabled() || commands.pending) return;
      const input = userInput ?? draftResources.input(text);
      if (props.metadataLoading) void submit(text, { ...(lastSubmitOptions.current ?? { contextScope: props.activePath ? "current-file" : "manuscript" }), userInput: input });
      else void steering.submit(text, { userInput: input });
    } } : {})}
    steeringPending={steering.pending}
    {...(disabledReason ? { disabledReason } : {})}
    {...(props.activePath ? { activePath: props.activePath } : {})}
    {...(pendingConversation ? {conversationTitle: "新对话"} : props.conversationId ? { ...(props.conversationTitle ? {conversationTitle: props.conversationTitle} : {}),
      conversationRename: {conversationId: props.conversationId, catalog: props.gateways?.catalog ?? agentCatalogGateway,
        metadata: props.gateways?.metadata ?? agentMetadataGateway,
        ...(props.onConversationTitleChanged ? {onRenamed: props.onConversationTitleChanged} : {}),
        ...(props.onRetryMetadata ? {onConflict: props.onRetryMetadata} : {})} } : {})} />;
}
