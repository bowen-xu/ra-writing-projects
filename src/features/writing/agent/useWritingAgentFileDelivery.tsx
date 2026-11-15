import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isWritingSourcePath } from "@research-assistant/writing";
import type { AgentApplicationState, AgentProposalReview } from "@research-assistant/core/agent";
import type { AgentSessionGateway, AgentProposalGateway, AgentWorkspaceReviewGateway, AgentWritingFileDeliveryGateway, AgentWorkspaceSuccessorGateway } from "@research-assistant/data/agent";
import { agentProposalGateway, agentWorkspaceReviewGateway, agentWritingFileDeliveryGateway, agentWorkspaceSuccessorGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { agentSessionGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import type { WritingGateway } from "../gateway";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { WritingCheckpointPersistence } from "../persistence/WritingCheckpointPersistence";
import type { AcceptWritingProposal } from "./useWritingProposalApplication";
import { WritingAgentFileDelivery } from "./WritingAgentFileDelivery";
import { WritingFileDeliveryRecovery, type WritingFileDeliveryRecoveryCommands } from "./WritingFileDeliveryRecovery";
import { WritingDeliveryConflict } from "./WritingDeliveryConflict";
import { openAgentConversation } from "@research-assistant/workbench-sdk/agent-ui";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { NotificationEffect } from "@research-assistant/workbench-sdk/feedback";
import { writingDeliveryToolGateway, type WritingDeliveryToolGateway } from "@research-assistant/workbench-sdk/agent-delivery";
import { writingSuccessorToolGateway, type WritingSuccessorToolGateway } from "@research-assistant/workbench-sdk/agent-delivery";
import { prepareWritingSuccessor } from "./prepareWritingSuccessor";
import {diagnosticError} from "@research-assistant/workbench-sdk/agent-diagnostics";

interface DiscoveryFailure {readonly manuscriptId: string; readonly diagnostic: string}
interface ListenerFailure extends DiscoveryFailure {readonly event: string}
function discoveryDiagnostic(code: string, manuscriptId: string, reason: unknown, event?: string): string {
  const safe = diagnosticError(reason), missingEvent = event && reason instanceof Error && reason.message === `预览未覆盖平台事件：${event}`;
  return [`code=${code}`, `M=${manuscriptId}`, ...(event ? [`event=${event}`] : []),
    `cause=${missingEvent ? "preview_event_port_missing" : safe.cause}`,
    ...["code", "requestId", "httpStatus"].flatMap(key => safe[key] === undefined ? [] : [`${key === "code" ? "causeCode" : key}=${safe[key]}`])].join("；");
}

export interface WritingAgentFileDeliveryGateways {
  readonly sessions: AgentSessionGateway;
  readonly proposals: Pick<AgentProposalGateway, "latest" | "publish" | "readFile"> & Partial<Pick<AgentProposalGateway, "reject">>;
  readonly reviews: Pick<AgentWorkspaceReviewGateway, "review" | "reviewBinding">;
  readonly deliveries: AgentWritingFileDeliveryGateway;
  readonly tools?: WritingDeliveryToolGateway;
  readonly successorTools?: WritingSuccessorToolGateway;
  readonly successorWorkspaces?: AgentWorkspaceSuccessorGateway;
}
const desktopGateways: WritingAgentFileDeliveryGateways = {
  sessions: agentSessionGateway, proposals: agentProposalGateway,
  reviews: agentWorkspaceReviewGateway, deliveries: agentWritingFileDeliveryGateway,
  tools: writingDeliveryToolGateway,
  successorTools: writingSuccessorToolGateway, successorWorkspaces: agentWorkspaceSuccessorGateway,
};
interface Options {
  readonly manuscriptId: string | undefined;
  readonly ready: boolean;
  readonly mutationsBlocked?: boolean;
  readonly gateway: WritingGateway;
  readonly files: WritingFileSessions;
  readonly checkpoints: WritingCheckpointPersistence;
  readonly accept: AcceptWritingProposal;
  readonly recovery?: WritingFileDeliveryRecoveryCommands;
  readonly onApplicationError?: (application: AgentApplicationState) => void;
  readonly agentGateways?: WritingAgentFileDeliveryGateways;
}
export function useWritingAgentFileDelivery(options: Options) {
  const gateways = options.agentGateways ?? desktopGateways;
  const rejectProposal = gateways.proposals.reject;
  const latest = useRef(options); latest.current = options;
  const alive = useRef(false);
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  const [discoveryError, setDiscoveryError] = useState<DiscoveryFailure | null>(null);
  const [listenerFailures, setListenerFailures] = useState<readonly ListenerFailure[]>([]);
  const [listenerRetry, setListenerRetry] = useState(0);
  const liveListenerFailures = useRef(listenerFailures), liveDiscoveryRetry = useRef(discoveryRetry);
  const discovery = useRef<{manuscriptId: string; receiver: WritingAgentFileDelivery; gateways: WritingAgentFileDeliveryGateways;
    retry: number; settled: boolean; error: DiscoveryFailure | null} | null>(null);
  const receiver = useMemo(() => new WritingAgentFileDelivery({ sessions: gateways.sessions,
    proposals: gateways.proposals, reviews: gateways.reviews,
    canApply: (manuscriptId) => alive.current && latest.current.ready && !latest.current.mutationsBlocked && latest.current.manuscriptId === manuscriptId,
    canResume: manuscriptId => alive.current && latest.current.ready && latest.current.manuscriptId === manuscriptId,
    isCurrentManuscript: manuscriptId => alive.current && latest.current.manuscriptId === manuscriptId,
    accept: async scope => {
      const recovery = latest.current.recovery;
      if (recovery) {
        const original = await recovery.gateway.find({ manuscriptId: scope.manuscriptId, conversationId: scope.conversationId, proposalId: scope.proposalId });
        if (original) {
          for (const file of original.files) if (file.phase === "dispatched") {
            // Recover observes the original intent/receipt. It never reapplies text.
            await recovery.recover(original.scope, file.path);
          }
        }
      }
      return latest.current.accept(scope);
    },
    findApplication: request => latest.current.recovery?.gateway.find(request) ?? Promise.resolve(null),
    acknowledge: (admission) => gateways.deliveries.acknowledge({ scope: admission.scope, turnId: admission.turnId }),
    ...(rejectProposal ? { rejectProposal } : {}),
    ...(gateways.tools ? { reportTool: gateways.tools.report } : {}),
    prepareFiles: async (proposal: AgentProposalReview) => {
      const host = latest.current, manuscriptId = proposal.review.binding.scope.manuscriptId;
      const existing = host.recovery ? await host.recovery.gateway.find({ manuscriptId,
        conversationId: proposal.review.binding.scope.conversationId, proposalId: proposal.proposalId }) : undefined;
      // Only existing textual targets join file-owned editing. Native handling
      // retains creation, deletion, binary/oversize and permission protections.
      for (const change of proposal.review.changes) {
        if (change.kind !== "modified" || !isWritingSourcePath(change.path)) continue;
        if (existing !== null && host.files.get({ manuscriptId, relativePath: change.path })) continue;
        const frozen = await gateways.proposals.readFile({ proposal: { manuscriptId,
          conversationId: proposal.review.binding.scope.conversationId, proposalId: proposal.proposalId }, path: change.path });
        if (!alive.current || !latest.current.ready || latest.current.manuscriptId !== manuscriptId) throw new Error("稿件暂时无法接收修改");
        if (frozen.file.before?.kind !== "text" || frozen.file.after?.kind !== "text") continue;
        let file = host.files.get({ manuscriptId, relativePath: change.path });
        if (!file) {
          const disk = await host.gateway.readFile(manuscriptId, change.path);
          if (!alive.current || !latest.current.ready || latest.current.manuscriptId !== manuscriptId) throw new Error("稿件暂时无法接收修改");
          await host.checkpoints.open(manuscriptId, disk);
          file = host.files.get({ manuscriptId, relativePath: change.path });
        }
        // A journal, including an uncertain one, wins over text comparison.
        // Current text can differ normally after users edit an applied Diff.
        if (existing === null && file && file.read().content !== frozen.file.before.text) throw new WritingDeliveryConflict();
      }
    },
  }), [options.files, options.checkpoints, options.gateway, gateways]);
  const liveReceiver = useRef(receiver); liveReceiver.current = receiver;
  useEffect(() => { alive.current = true; const disconnect = receiver.connect();
    return () => { alive.current = false; disconnect(); }; }, [receiver]);
  useEffect(() => {
    let active = true;
    const manuscriptId = options.manuscriptId, disconnects: (() => void)[] = [];
    liveListenerFailures.current = []; setListenerFailures(liveListenerFailures.current);
    if (!manuscriptId) return;
    const ownerId = manuscriptId;
    function connect(event: string, subscribe: () => Promise<() => void>): void {
      void Promise.resolve().then(subscribe).then(release => {if (active) disconnects.push(release); else release();})
        .catch(reason => {if (active) {
          const next = [...liveListenerFailures.current, {event, manuscriptId: ownerId,
            diagnostic: discoveryDiagnostic("WRITING_DELIVERY_LISTEN_FAILED", ownerId, reason, event)}];
          liveListenerFailures.current = next; setListenerFailures(next);
        }});
    }
    const deliveryTools = gateways.tools;
    if (deliveryTools) connect("research-writing-file-delivery", () => deliveryTools.listen(request => {
      if (active && request.scope.manuscriptId === manuscriptId && latest.current.manuscriptId === manuscriptId) receiver.requestTool(request);
    }));
    const tools = gateways.successorTools, workspaces = gateways.successorWorkspaces;
    if (tools && workspaces) connect("research-writing-successor-workspace", () => tools.listen(request => {
      if (active && request.scope.manuscriptId === manuscriptId && latest.current.manuscriptId === manuscriptId) void prepareWritingSuccessor(request, {
        current: () => active && alive.current ? latest.current : null, tools, workspaces,
      }).catch(() => { /* The native waiter handles an unknown report. */ });
    }));
    return () => {active = false; for (const disconnect of disconnects) disconnect();};
  }, [receiver, gateways.tools, gateways.successorTools, gateways.successorWorkspaces, options.manuscriptId, listenerRetry]);
  const snapshot = useSyncExternalStore(receiver.subscribe, receiver.getSnapshot);
  useEffect(() => {
    for (const entry of snapshot) if (entry.scope.manuscriptId === options.manuscriptId && entry.status === "error"
      && entry.failureStage === "application" && entry.application) options.onApplicationError?.(entry.application);
  }, [snapshot, options.manuscriptId, options.onApplicationError]);
  useEffect(() => {
    const manuscriptId = options.manuscriptId;
    let current = true;
    setDiscoveryError(null);
    const observation = manuscriptId ? {manuscriptId, receiver, gateways, retry: discoveryRetry, settled: false, error: null as DiscoveryFailure | null} : null;
    discovery.current = observation;
    if (manuscriptId) void (async () => {
      let after: number | null = null;
      do {
        const page = await gateways.deliveries.list({ manuscriptId, after, limit: 64 });
        if (!current) return;
        for (const entry of page.items) receiver.register({ scope: entry.scope, turnId: entry.turnId });
        after = page.nextCursor;
      } while (after !== null);
      if (observation) observation.settled = true;
    })().catch(reason => { if (current) {
      const error = {manuscriptId, diagnostic: discoveryDiagnostic("WRITING_DELIVERY_DISCOVERY_FAILED", manuscriptId, reason)};
      if (observation) {observation.error = error; observation.settled = true;}
      setDiscoveryError(error);
    } });
    return () => { current = false; };
  }, [receiver, gateways, options.manuscriptId, discoveryRetry]);
  useEffect(() => { receiver.resume(); }, [receiver, options.manuscriptId, options.ready, options.mutationsBlocked]);
  const pending = snapshot.filter((entry) => entry.scope.manuscriptId === options.manuscriptId
    && entry.status === "error"
    && !(options.onApplicationError && entry.failureStage === "application" && entry.application));
  const failedListeners = listenerFailures.filter(failure => failure.manuscriptId === options.manuscriptId);
  const hasPending = useCallback(() => {
    const current = latest.current, manuscriptId = current.manuscriptId, observed = discovery.current;
    if (!manuscriptId) return false;
    return !observed || observed.manuscriptId !== manuscriptId || observed.receiver !== liveReceiver.current
      || observed.gateways !== (current.agentGateways ?? desktopGateways) || observed.retry !== liveDiscoveryRetry.current
      || !observed.settled || observed.error !== null
      || liveReceiver.current.getSnapshot().some(entry => entry.scope.manuscriptId === manuscriptId)
      || liveListenerFailures.current.some(failure => failure.manuscriptId === manuscriptId);
  }, []);
  const feedback = <>{failedListeners.map(failure => <div key={failure.event} className="writing-file-recovery-actions" role="group" aria-label="监听 Agent 文件修改">
    <NotificationEffect id={`writing-delivery-listen:${failure.event}:${failure.manuscriptId}`} message={`Agent 文件修改事件监听失败，当前编辑状态已保留。可在“文件修改待处理”中重新连接。 [${failure.diagnostic}]`} />
    <button type="button" onClick={() => setListenerRetry(value => value + 1)}>重新连接监听</button>
  </div>)}{discoveryError?.manuscriptId === options.manuscriptId && discoveryError && <div className="writing-file-recovery-actions" role="group" aria-label="读取 Agent 文件修改">
    <NotificationEffect id={`writing-delivery-discovery:${discoveryError.manuscriptId}`} message={`尚未完成的 Agent 文件修改记录读取失败，当前编辑状态已保留。可在“文件修改待处理”中重试。 [${discoveryError.diagnostic}]`} />
    <button type="button" onClick={() => {liveDiscoveryRetry.current++; setDiscoveryRetry(liveDiscoveryRetry.current);}}>重新读取</button>
  </div>}{pending.map((entry) => <div className="writing-file-recovery-actions" role="group" aria-label="处理 Agent 文件修改" key={entry.turnId}>
    {!entry.toolOwned && <NotificationEffect id={`writing-delivery:${entry.turnId}`} message={entry.conflict
      ? "旧修改与当前稿件版本不一致，当前内容已保留。请核对来源或放弃这次修改。"
      : entry.failureStage === "acknowledgement" ? "交付记录待确认，当前文件结果已保留。"
      : "接收文件修改尚未确认，当前内容已保留。请核对原操作。"} />}
    {entry.conflict ? <>
      <button type="button" onClick={() => { void openAgentConversation(entry.scope.conversationId).catch(() => notify.error("无法打开来源对话，当前稿件已保留。")); }}>查看来源对话</button>
      {gateways.proposals.reject && <button type="button" disabled={!options.ready} onClick={() => { void receiver.discardConflict(entry); }}>保留当前稿件，放弃这次修改</button>}
      <button type="button" disabled={!options.ready} onClick={() => receiver.retry(entry)}>重新检查版本</button>
    </> : entry.status === "error" && entry.failureStage === "application" && entry.application && options.recovery
      ? <WritingFileDeliveryRecovery application={entry.application} commands={options.recovery}
        disabled={!options.ready || options.manuscriptId !== entry.scope.manuscriptId} onResult={result => receiver.recordApplication(entry, result)} />
      : <button type="button" disabled={!options.ready || options.manuscriptId !== entry.scope.manuscriptId}
        onClick={() => receiver.retry(entry)}>{entry.failureStage === "acknowledgement" ? "重试确认记录" : "重新核对"}</button>}
  </div>)}</>;
  return { register: receiver.register, flush: receiver.flush, feedback, hasPending, recordRecoveredApplication: receiver.recordRecoveredApplication, entries: snapshot,
    pending: snapshot.some(entry => entry.scope.manuscriptId === options.manuscriptId)
      || failedListeners.length > 0 || (!!discoveryError && discoveryError.manuscriptId === options.manuscriptId) };
}
