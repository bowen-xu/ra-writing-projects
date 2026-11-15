import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { countWritingChangedLines, type WritingWorkspaceChangeStats } from "@research-assistant/workbench-sdk/text-diff-stats";
export type { WritingWorkspaceChangeStats } from "@research-assistant/workbench-sdk/text-diff-stats";
import type { AgentWorkspaceScope, AgentWorkspaceReview, AgentWorkspaceChange, AgentWorkspaceFileReview } from "@research-assistant/core/agent";
import { agentWorkspaceReviewGateway, agentProposalGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { openSourceLink } from "@research-assistant/workbench-sdk/source-navigation";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { diagnosticError } from "@research-assistant/workbench-sdk/agent-diagnostics";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import "./WritingWorkspaceReview.css";

import { AgentChangeContribution } from "@research-assistant/workbench-sdk/agent-presentation";
import { WritingWorkspaceDiscard } from "./WritingWorkspaceDiscard";
import type { AgentProposalGateway, AgentWorkspaceReviewGateway } from "@research-assistant/data/agent";
import type { AgentWorkspaceDiscardGateway } from "@research-assistant/data/agent";
import type { UndoWritingProposal } from "./writingCardUndo";
import type { WritingAgentDeliverySnapshot } from "./WritingAgentFileDelivery";

const noSubscription = (): (() => void) => () => undefined;
const noRevision = (): number => 0;

export interface WritingWorkspaceReviewGateways {
  readonly workspaceReviewGateway?: AgentWorkspaceReviewGateway;
  readonly proposalGateway?: AgentProposalGateway;
  readonly workspaceDiscardGateway?: AgentWorkspaceDiscardGateway;
}

interface Props extends WritingWorkspaceReviewGateways {
  readonly scope: AgentWorkspaceScope;
  readonly publishedProposalId?: string;
  /** Blocks mutations only; frozen historical content remains readable. */
  readonly disabled: boolean;
  readonly label?: string;
  readonly showManageCopy?: boolean;
  readonly activePath?: string;
  readonly fileSessions?: WritingFileSessions;
  readonly onJumpToEditor?: (path: string) => void;
  readonly undoProposal?: UndoWritingProposal;
  readonly delivery?: WritingAgentDeliverySnapshot | undefined;
  /** Exact file paths in the currently visible, confirmed summary. */
  readonly onAvailablePathsChange?: ((paths: readonly string[]) => void) | undefined;
  /** Report read failures to the owning conversation without exposing a status card. */
  readonly onReadErrorChange?: ((error: { readonly message: string; readonly retry: () => void } | null) => void) | undefined;
}

/** Frozen review card and statistics; file commands belong to the workspace. */
export function WritingWorkspaceChangeSummary(props: Props): React.JSX.Element | null {
  const workspaceGateway = props.workspaceReviewGateway ?? agentWorkspaceReviewGateway;
  const proposalGateway = (): AgentProposalGateway => {
    const value = props.proposalGateway ?? agentProposalGateway;
    if (!value) throw new Error("Proposal gateway unavailable");
    return value;
  };
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [inventory, setInventory] = useState<AgentWorkspaceReview | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [changeStats, setChangeStats] = useState<Readonly<Record<string, WritingWorkspaceChangeStats>>>({});
  const [frozenAfter, setFrozenAfter] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [undoBusy, setUndoBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = JSON.stringify([props.scope.conversationId, props.scope.manuscriptId, props.scope.requestId, props.scope.contextSnapshotId, props.publishedProposalId]);
  const loadedScope = useRef<string | null>(null);
  const availabilityCallback = useRef(props.onAvailablePathsChange);
  availabilityCallback.current = props.onAvailablePathsChange;
  const readErrorCallback = useRef(props.onReadErrorChange);
  readErrorCallback.current = props.onReadErrorChange;
  const undoPending = useRef(false);
  useSyncExternalStore(props.fileSessions?.subscribe ?? noSubscription, props.fileSessions?.getRevision ?? noRevision);
  // Completion history may render this card before proposal publication. Only
  // this submission's durable file operations authorize a read-only refresh.
  const deliveryIdentity = useSyncExternalStore(props.fileSessions?.subscribe ?? noSubscription,
    () => JSON.stringify(props.fileSessions?.forManuscript(props.scope.manuscriptId).flatMap(session =>
      session.readOperations().filter(operation => operation.conversationId === props.scope.conversationId
        && operation.requestId === props.scope.requestId).map(operation => [session.identity.relativePath, operation.operationId])) ?? []));
  const readFile = async (review: AgentWorkspaceReview, change: AgentWorkspaceChange, durableId: string | null): Promise<AgentWorkspaceFileReview> => {
    if (durableId) {
      return (await proposalGateway().readFile({ proposal: { conversationId: review.binding.scope.conversationId, manuscriptId: review.binding.scope.manuscriptId, proposalId: durableId }, path: change.path })).file;
    }
    return workspaceGateway.readFile({ binding: review.binding, path: change.path, before: change.before, after: change.after });
  };
  useEffect(() => {
    let current = true;
    const reportError = readErrorCallback.current;
    if (props.delivery && !props.publishedProposalId) {
      reportError?.(null);
      return () => { current = false; };
    }
    const sameScope = loadedScope.current === scopeKey;
    loadedScope.current = scopeKey;
    setRefreshing(true);
    if (!sameScope) {
      setState("loading");
      setInventory(null);
      setProposalId(null);
      setConfirmed(false);
      setChangeStats({});
      setFrozenAfter(new Map());
    }
    void (async () => {
      if (typeof workspaceGateway.review !== "function") throw new Error("Workspace review unavailable");
      // A proposal is durable across view lifecycles. Prefer its frozen review
      // after a restart so reopening a conversation does not depend on the
      // old execution workspace or an in-memory submission preview.
      const savedProposal = props.publishedProposalId
        ? await proposalGateway().review({conversationId: props.scope.conversationId,
          manuscriptId: props.scope.manuscriptId, proposalId: props.publishedProposalId})
        : await proposalGateway().latest(props.scope);
      if (savedProposal && ((props.publishedProposalId && savedProposal.proposalId !== props.publishedProposalId) ||
        (["conversationId", "manuscriptId", "requestId", "contextSnapshotId"] as const)
          .some(field => savedProposal.review.binding.scope[field] !== props.scope[field]))) throw new Error("文件变更身份不匹配");
      const review = savedProposal?.review ?? await workspaceGateway.review(props.scope);
      if (!current) return;
      setInventory(review);
      setProposalId(savedProposal?.proposalId ?? null);
      setConfirmed(savedProposal?.status === "applied" || savedProposal?.status === "undone");
      setChangeStats({});
      setFrozenAfter(new Map());
      const paths = review.changes.map((change) => change.path);
      setState(paths.length === 0 ? "empty" : "ready");
      setRefreshFailed(false);
      setRefreshing(false);
      reportError?.(null);
    })().catch((reason: unknown) => {
      if (!current) return;
      setRefreshing(false);
      setRefreshFailed(true);
      if (!sameScope) setState("error");
      const diagnostic = diagnosticError(reason);
      const fields = [`code=${diagnostic.code ?? "WORKSPACE_REVIEW_UNAVAILABLE"}`, `C=${props.scope.conversationId}`, `R=${props.scope.requestId}`,
        ...(diagnostic.cause ? [`cause=${diagnostic.cause}`] : []), ...(diagnostic.httpStatus ? [`http=${diagnostic.httpStatus}`] : [])];
      reportError?.({message:`无法读取文件变更。 [${fields.join("；")}]`, retry: () => { if (current) setAttempt(value => value + 1); }});
    });
    return () => { current = false; };
  }, [scopeKey, deliveryIdentity, attempt, !!props.delivery]);
  useEffect(() => {
    const reportError = readErrorCallback.current;
    return () => reportError?.(null);
  }, [scopeKey]);
  const availablePaths = loadedScope.current === scopeKey && state === "ready" && (!props.delivery || confirmed)
    ? inventory?.changes.map(change => change.path) ?? [] : [];
  const availablePathsKey = JSON.stringify(availablePaths);
  useEffect(() => {
    const callback = availabilityCallback.current;
    callback?.(JSON.parse(availablePathsKey) as string[]);
    return () => callback?.([]);
  }, [availablePathsKey, scopeKey]);
  useEffect(() => {
    if (!inventory || (proposalId === null && typeof workspaceGateway.readFile !== "function")) return;
    let current = true;
    void Promise.all(inventory.changes.map(async (change) => {
      try {
        const file = await readFile(inventory, change, proposalId);
        if ((file.before !== null && file.before.kind !== "text") || (file.after !== null && file.after.kind !== "text")) return null;
        return { path: change.path, stats: countWritingChangedLines(file.before?.text ?? "", file.after?.text ?? ""), after: file.after?.text ?? null };
      } catch {
        return null;
      }
    })).then((entries) => {
      if (current) {
        const readable = entries.filter(entry => entry !== null);
        setChangeStats(Object.fromEntries(readable.map(entry => [entry.path, entry.stats])));
        setFrozenAfter(new Map(readable.map(entry => [entry.path, entry.after])));
      }
    });
    return () => { current = false; };
  }, [inventory, proposalId, props.proposalGateway, workspaceGateway]);
  // Pending/failed deliveries remain in the file owner for recovery, but are
  // not successful historical edits and must not render a chat diff card.
  if (props.delivery && !confirmed) return null;
  if (loadedScope.current !== scopeKey || state !== "ready" || !inventory) return null;
  const totalStats = inventory.changes.reduce((totals, change) => {
    const stats = changeStats[change.path];
    return stats ? { additions: totals.additions + stats.additions, deletions: totals.deletions + stats.deletions } : totals;
  }, { additions: 0, deletions: 0 });
  const hasStats = Object.keys(changeStats).length > 0;
  // This is an advisory check against live D, never against mutable review B.
  // The workspace/native command still validates every target at dispatch.
  const changedSince = inventory.changes.some(change => {
    const session = props.fileSessions?.get({ manuscriptId: props.scope.manuscriptId, relativePath: change.path });
    return session && frozenAfter.has(change.path) && session.read().content !== frozenAfter.get(change.path);
  });
  const checkingUndo = inventory.changes.some(change => props.fileSessions?.get({ manuscriptId: props.scope.manuscriptId,
    relativePath: change.path }) && !frozenAfter.has(change.path));
  const undoReason = changedSince ? "文件已有后续修改，无法完整撤销本轮修改。" : checkingUndo ? "正在核对本轮文件版本。" : undefined;
  const openFile = (path: string): void => {
    if (props.onJumpToEditor) props.onJumpToEditor(path);
    else openSourceLink(`source://writings/${props.scope.manuscriptId}/${path}`);
  };
  const undo=proposalId&&props.undoProposal?{busy:undoBusy,disabled:props.disabled||!!props.delivery||undoBusy||refreshing||refreshFailed||!!undoReason,title:undoReason,run:async()=>{
    if(undoPending.current)return false;
    undoPending.current=true;setUndoBusy(true);
    try{
      const result=await props.undoProposal!({manuscriptId:props.scope.manuscriptId,conversationId:props.scope.conversationId,proposalId});
      if(result.kind!=="state"||result.state.status!=="applied"){
        notify.error("撤销尚未确认。当前内容已保留，请核对是否有后续修改，再重试原撤销。");return false;
      }
      return true;
    }catch{notify.error("撤销尚未确认，当前内容已保留。");return false;}
    finally{undoPending.current=false;setUndoBusy(false);}
  }}:undefined;
  return <AgentChangeContribution ariaLabel="消息中的文件改动"
    {...(proposalId ? {ownerIdentity: JSON.stringify(["writingProposal", props.scope.manuscriptId, props.scope.conversationId,
      props.scope.requestId, props.scope.contextSnapshotId, proposalId])} : {})}
    {...(hasStats ? { stats: totalStats } : {})}
    items={inventory.changes.map(change => ({ id: change.path, identity:`source://writings/${props.scope.manuscriptId}/${change.path}`, label: change.path, path: change.path,
      ...(changeStats[change.path] ? { stats: changeStats[change.path] } : {}), onOpen: () => openFile(change.path) }))}
    undo={undo}>
  </AgentChangeContribution>;
}

/** Execution-copy history uses the same resource summary and direct navigation. */
export function WritingWorkspaceReview(props: Props): React.JSX.Element {
  const [discard, setDiscard] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="writing-agent-review-entry">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{props.label ?? "查看修改文件"}</button>
    {expanded && <WritingWorkspaceChangeSummary {...props} />}
    {props.showManageCopy !== false && <button ref={trigger} type="button" disabled={props.disabled} onClick={() => setDiscard(true)}>管理执行副本</button>}
    {discard && <WritingWorkspaceDiscard key={JSON.stringify(props.scope)} scope={props.scope} disabled={props.disabled}
      {...(props.workspaceDiscardGateway === undefined ? {} : { gateway: props.workspaceDiscardGateway })}
      onClose={() => { setDiscard(false); trigger.current?.focus(); }} />}
  </div>;
}
