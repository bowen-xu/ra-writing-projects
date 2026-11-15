import { useCallback, useMemo } from "react";
import type { AgentApplicationState, AgentPendingWritingApplicationRequest } from "@research-assistant/core/agent";
import type { AgentPendingWritingApplicationGateway } from "@research-assistant/data/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";
import { matchesWritingApplication, WritingFileDeliveryRecovery, type WritingFileDeliveryRecoveryCommands } from "./WritingFileDeliveryRecovery";
import { useWritingOperationDiscovery } from "./useWritingOperationDiscovery";
import { NotificationEffect } from "@research-assistant/workbench-sdk/feedback";

interface Entry { readonly scope: AgentApplicationState["scope"]; readonly state: AgentApplicationState }
const applicationKey = (entry: Entry): string => entry.scope.operationId;

/** Original applications and independent Undo share the same read-only startup
 * projection. Native journals and existing coordinators retain execution ownership. */
export function useWritingApplicationRecovery(manuscriptId: string | undefined,
  discovery: AgentPendingWritingApplicationGateway, workspaceIdentity: unknown) {
  const readPage = useMemo(() => async (request: AgentPendingWritingApplicationRequest) => {
    const page = await discovery.list(request);
    return { ...page, items: page.items.map(({ application }) => ({ scope: application.scope, state: application })) };
  }, [discovery]);
  const scan = useWritingOperationDiscovery(manuscriptId, workspaceIdentity, readPage, applicationKey);
  const observe = useCallback((state: AgentApplicationState) => scan.observe({ scope: state.scope, state }), [scan.observe]);
  const record = useCallback((application: AgentApplicationState, result: EditorApplicationResult) => {
    if (!("state" in result) || !result.state || !matchesWritingApplication(application, result.state)) return;
    const entry = { scope: result.state.scope, state: result.state };
    if (result.kind === "state" && ["applied", "rolledBack"].includes(result.state.status)) scan.dismiss(entry);
    else scan.observe(entry);
  }, [scan.observe, scan.dismiss]);
  return { ...scan, manuscriptId, observe, record };
}

export function WritingApplicationRecoveryFeedback({ recovery, commands, ready, onResult, silentOperationIds = [] }: {
  readonly recovery: ReturnType<typeof useWritingApplicationRecovery>;
  readonly commands: WritingFileDeliveryRecoveryCommands;
  readonly ready: boolean;
  readonly onResult: (application: AgentApplicationState, result: EditorApplicationResult) => Promise<void>;
  readonly silentOperationIds?: readonly string[];
}): React.JSX.Element {
  return <>
    {recovery.failed && <section className="writing-file-recovery-actions" role="group" aria-label="读取文件操作记录">
      <NotificationEffect id={`writing-application-discovery:${recovery.manuscriptId}`} message="未能读取文件操作记录，当前内容已保留。读取成功前暂停后续 Agent 文件修改。" />
      <button type="button" onClick={recovery.retry}>重新读取文件操作记录</button>
    </section>}
    {recovery.entries.map(({ state }) => <section className="writing-file-recovery-actions" role="group" aria-label="处理文件操作" key={state.scope.operationId}>
      {!["applied", "rolledBack"].includes(state.status) && !silentOperationIds.includes(state.scope.operationId) && <NotificationEffect id={`writing-application:${state.scope.operationId}`}
        message="接收文件修改尚未确认，当前内容已保留。请在文件修改待处理中核对原操作。" />}
      <WritingFileDeliveryRecovery application={state} commands={commands} disabled={!ready || recovery.loading || recovery.failed}
        onResult={async result => { recovery.record(state, result); await onResult(state, result); }} />
    </section>)}
  </>;
}
