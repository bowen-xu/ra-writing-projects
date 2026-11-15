import { useEffect, useRef, useState } from "react";
import type { AgentApplicationState } from "@research-assistant/core/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";
import type { WritingProposalApplicationGateways, useWritingProposalApplication } from "./useWritingProposalApplication";
import { canRollbackApplication } from "./writingApplicationRollback";
import { notify } from "@research-assistant/workbench-sdk/feedback";

export interface WritingFileDeliveryRecoveryCommands extends Pick<ReturnType<typeof useWritingProposalApplication>, "accept" | "recover" | "rollback"> {
  readonly gateway: WritingProposalApplicationGateways["applications"];
}
type Command = "read" | "reconcile" | "retry" | "rollback" | "save";
export function matchesWritingApplication(before: AgentApplicationState, after: AgentApplicationState): boolean {
  return (["manuscriptId", "conversationId", "proposalId", "operationId"] as const)
    .every(key => before.scope[key] === after.scope[key]);
}
function canRetry(state: AgentApplicationState): boolean {
  return ["applying", "recoveryRequired"].includes(state.status) && state.files.length > 0
    && state.files.every(file => file.phase === "pending");
}

/** Workspace projection of the existing application journal and protected
 * commands. Read/reconcile never continue pending targets or save file text. */
export function WritingFileDeliveryRecovery({ application, commands, disabled, onResult }: {
  readonly application: AgentApplicationState;
  readonly commands: WritingFileDeliveryRecoveryCommands;
  readonly disabled: boolean;
  readonly onResult: (result: EditorApplicationResult) => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(false);
  const latest = useRef({ application, disabled }); latest.current = { application, disabled };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function perform(command: Command): Promise<void> {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true);
    // A protected command temporarily disables the host while it holds its
    // lease; that must not discard its result. Workspace/scope replacement does.
    const current = () => alive.current && matchesWritingApplication(application, latest.current.application);
    const fail = () => { if (current()) notify.error("文件结果尚未确认，当前内容已保留。请检查后续修改或存储故障，再重试原操作。", { id: `writing-file-status:${application.scope.manuscriptId}` }); };
    try {
      const observed = await commands.gateway.execute({ action: "read", scope: application.scope });
      if (!current()) return;
      if (observed.kind !== "state" || !matchesWritingApplication(application, observed)) { fail(); return; }
      // Even a terminal read does not prove that formal saving completed.
      await onResult({ kind: "unconfirmed", state: observed });
      if (!current() || command === "read") return;
      if (command === "reconcile") {
        for (const file of observed.files.filter(file => file.phase === "dispatched")) {
          if (!current()) return;
          const result = await commands.recover(observed.scope, file.path);
          if (!current()) return;
          if (!("state" in result) || !result.state || !matchesWritingApplication(observed, result.state)) { fail(); return; }
          await onResult({ kind: "unconfirmed", state: result.state });
          if (!current()) return;
          if (result.kind !== "state" || !result.state.files.some(item => item.path === file.path && item.phase === "acknowledged")) {
            fail(); return;
          }
        }
        return;
      }
      let result: EditorApplicationResult = { kind: "unconfirmed", state: observed };
      if (command === "rollback" && (canRollbackApplication(observed) || observed.status === "rolledBack")) {
        result = await commands.rollback(observed.scope);
      } else if (command === "retry" && canRetry(observed)) {
        result = await commands.accept(observed.scope);
      } else if (command === "save") {
        if (observed.status === "applied") result = await commands.accept(observed.scope);
        else if (observed.status === "rolledBack") result = await commands.rollback(observed.scope);
      }
      if (!current()) return;
      if ("state" in result && result.state && !matchesWritingApplication(observed, result.state)) { fail(); return; }
      await onResult(result);
      if (result.kind !== "state" || !["applied", "rolledBack"].includes(result.state.status)) fail();
    } catch { fail(); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <>
    <button type="button" disabled={disabled || busy} onClick={() => { void perform("read"); }}>刷新文件操作状态</button>
    {application.files.some(file => file.phase === "dispatched") && <button type="button" disabled={disabled || busy}
      onClick={() => { void perform("reconcile"); }}>核对文件结果</button>}
    {canRetry(application) && <button type="button" disabled={disabled || busy} onClick={() => { void perform("retry"); }}>继续原文件修改</button>}
    {canRollbackApplication(application) && <button type="button" disabled={disabled || busy} onClick={() => { void perform("rollback"); }}>恢复应用前内容</button>}
    {["applied", "rolledBack"].includes(application.status) && <button type="button" disabled={disabled || busy}
      onClick={() => { void perform("save"); }}>重试保存文件结果</button>}
    {busy && <span>正在核对与处理…</span>}
  </>;
}
