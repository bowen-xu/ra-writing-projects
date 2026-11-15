import { useCallback, useMemo } from "react";
import type { AgentPendingWritingUndoGateway } from "@research-assistant/data/agent";
import type { WritingCardUndoResult } from "./writingCardUndo";
import { matchesWritingUndo, WritingUndoRecoveryNotice, type WritingUndoRecoveryEntry } from "./WritingUndoRecoveryNotice";
import type { WritingProposalApplicationGateways, useWritingProposalApplication } from "./useWritingProposalApplication";

import { useWritingOperationDiscovery } from "./useWritingOperationDiscovery";
import { NotificationEffect } from "@research-assistant/workbench-sdk/feedback";

const undoKey = (entry: WritingUndoRecoveryEntry): string => entry.undoId;

/** Only unresolved command identities are retained; native journals own progress. */
export function useWritingUndoRecovery(manuscriptId: string | undefined, ready: boolean,
  gateway: WritingProposalApplicationGateways["undos"], actions: ReturnType<typeof useWritingProposalApplication>,
  discovery: AgentPendingWritingUndoGateway, workspaceIdentity: unknown) {
  const readPage = useMemo(() => async (request: Parameters<AgentPendingWritingUndoGateway["list"]>[0]) => {
    const page = await discovery.list(request);
    return { ...page, items: page.items.map(({ undo }) => {
      if (!undo.result || undo.result.kind !== "state") throw new Error("撤销发现记录无效");
      const entry = { scope: undo.originalScope, undoId: undo.undoId, state: undo.result };
      if (!matchesWritingUndo(entry, undo.result)) throw new Error("撤销发现范围无效");
      return entry;
    }) };
  }, [discovery]);
  const scan = useWritingOperationDiscovery<WritingUndoRecoveryEntry>(manuscriptId, workspaceIdentity, readPage, undoKey);
  const observe = useCallback((entry: WritingUndoRecoveryEntry) => {
    if (!entry.state || matchesWritingUndo(entry, entry.state)) scan.observe(entry);
  }, [scan.observe]);
  const record = useCallback(({ scope, undoId, result }: WritingCardUndoResult) => {
    const entry = { scope, undoId, state: "state" in result ? result.state : null };
    if (entry.state && !matchesWritingUndo(entry, entry.state)) { observe({ ...entry, state: null }); return; }
    if (result.kind === "state" && ["applied", "rolledBack"].includes(result.state.status)) scan.dismiss(entry);
    else observe(entry);
  }, [observe, scan.dismiss]);
  const { loading, failed, entries: current, dismiss } = scan;
  return { record, pending: scan.pending, hasPending: scan.hasPending, feedback: <>
    {failed && <section className="writing-undo-recovery" role="group" aria-label="读取文件撤销记录">
      <NotificationEffect id={`writing-undo-discovery:${manuscriptId}`} message="未能读取文件撤销记录，当前内容已保留。读取成功前暂停后续 Agent 文件修改。" />
      <div className="writing-undo-recovery-actions"><button type="button" onClick={scan.retry}>重新读取撤销记录</button></div>
    </section>}
    {current.map(entry =>
    <WritingUndoRecoveryNotice key={entry.undoId} entry={entry} gateway={gateway} actions={actions}
      disabled={!ready || loading || failed} onObserved={observe} onResult={record} onDismiss={dismiss} />)}
  </> };
}
