import { useEffect, useRef, useState } from "react";
import type { AgentApplicationScope, AgentApplicationState } from "@research-assistant/core/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";
import type { WritingProposalApplicationGateways, useWritingProposalApplication } from "./useWritingProposalApplication";
import { canRollbackUndo } from "./writingUndoRollback";
import type { WritingCardUndoResult } from "./writingCardUndo";
import { NotificationEffect } from "@research-assistant/workbench-sdk/feedback";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import "./WritingUndoRecovery.css";

export interface WritingUndoRecoveryEntry {
  readonly scope: AgentApplicationScope;
  readonly undoId: string;
  readonly state: AgentApplicationState | null;
}
type Actions = Pick<ReturnType<typeof useWritingProposalApplication>, "undo" | "startUndo" | "resumeUndo" | "recoverUndo" | "rollbackUndo" | "cancelUndo">;
type Command = "read" | "reconcile" | "continue" | "rollback" | "cancel" | "save";
export function matchesWritingUndo(entry: WritingUndoRecoveryEntry, state: AgentApplicationState): boolean {
  return state.scope.operationId === entry.undoId && (["manuscriptId", "conversationId", "proposalId"] as const)
    .every(key => state.scope[key] === entry.scope[key]);
}

/** Workspace feedback projects native progress; it owns no file text or recovery protocol. */
export function WritingUndoRecoveryNotice({ entry, gateway, actions, disabled, onObserved, onResult, onDismiss }: {
  readonly entry: WritingUndoRecoveryEntry;
  readonly gateway: WritingProposalApplicationGateways["undos"];
  readonly actions: Actions;
  readonly disabled: boolean;
  readonly onObserved: (entry: WritingUndoRecoveryEntry) => void;
  readonly onResult: (value: WritingCardUndoResult) => void;
  readonly onDismiss: (entry: WritingUndoRecoveryEntry) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(false), latest = useRef({ entry, disabled });
  latest.current = { entry, disabled };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function perform(command: Command): Promise<void> {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true);
    const current = () => alive.current && latest.current.entry.undoId === entry.undoId
      && (["manuscriptId", "conversationId", "proposalId", "operationId"] as const)
        .every(key => latest.current.entry.scope[key] === entry.scope[key]);
    const fail = () => { if (current()) notify.error("结果仍未确认。请检查后续修改或存储故障，再重试原操作。", { id: `writing-undo-command:${entry.undoId}` }); };
    try {
      const observed = (await gateway.execute({ scope: entry.scope, undoId: entry.undoId, command: { action: "read" } })).result;
      if (!current()) return;
      if (observed === null) {
        onObserved({ ...entry, state: null });
        if (command === "cancel") onDismiss(entry);
        else if (command === "continue") onResult({ scope: entry.scope, undoId: entry.undoId,
          result: await actions.undo(entry.scope, entry.undoId) });
        else if (command !== "read") fail();
        return;
      }
      if (observed.kind !== "state" || !matchesWritingUndo(entry, observed)) { fail(); return; }
      onObserved({ ...entry, state: observed });
      if (command === "read") return;
      let result: EditorApplicationResult = { kind: "unconfirmed", state: observed };
      if (command === "reconcile") {
        for (const file of observed.files.filter(file => file.phase === "dispatched")) {
          if (!current()) return;
          result = await actions.recoverUndo(entry.scope, entry.undoId, file.path);
          if (result.kind !== "state" || !matchesWritingUndo(entry, result.state)
            || !result.state.files.some(item => item.path === file.path && item.phase === "acknowledged")) break;
          onObserved({ ...entry, state: result.state });
        }
      } else if (command === "continue") {
        if (observed.status === "prepared") result = await actions.startUndo(entry.scope, entry.undoId);
        else if (canContinue(observed)) result = await actions.resumeUndo(entry.scope, entry.undoId);
      } else if (command === "rollback" && (canRollbackUndo(observed) || observed.status === "rolledBack")) {
        result = await actions.rollbackUndo(entry.scope, entry.undoId);
      } else if (command === "cancel" && canCancel(observed)) {
        result = await actions.cancelUndo(entry.scope, entry.undoId);
      } else if (command === "save") {
        if (observed.status === "applied") result = await actions.undo(entry.scope, entry.undoId);
        else if (observed.status === "rolledBack") result = await actions.rollbackUndo(entry.scope, entry.undoId);
      }
      // Reconciliation only proves receipts. Formal save is a separate protected
      // command even when the last recovered receipt completes the native log.
      if (command === "reconcile") {
        if ("state" in result && result.state && matchesWritingUndo(entry, result.state)) onObserved({ ...entry, state: result.state });
      } else onResult({ scope: entry.scope, undoId: entry.undoId, result });
      if (result.kind !== "state" || !matchesWritingUndo(entry, result.state)) fail();
    } catch { fail(); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const state = entry.state;
  return <section className="writing-undo-recovery" role="group" aria-label="文件撤销恢复">
    <NotificationEffect id={`writing-undo:${entry.scope.manuscriptId}:${entry.undoId}`} message="整批撤销尚未完成确认，当前文件内容已保留。" />
    {state && <span>{state.files.length} 个文件 · {state.files.slice(0, 3).map(file => file.path).join("、")}{state.files.length > 3 ? "…" : ""}</span>}
    <div className="writing-undo-recovery-actions">
      <button type="button" disabled={disabled || busy} onClick={() => { void perform("read"); }}>刷新撤销状态</button>
      {state?.files.some(file => file.phase === "dispatched") && <button type="button" disabled={disabled || busy} onClick={() => { void perform("reconcile"); }}>核对撤销结果</button>}
      {!state && <button type="button" disabled={disabled || busy} onClick={() => { void perform("continue"); }}>重试原撤销</button>}
      {state && (state.status === "prepared" || canContinue(state)) && <button type="button" disabled={disabled || busy} onClick={() => { void perform("continue"); }}>继续原撤销</button>}
      {state && canRollbackUndo(state) && <button type="button" disabled={disabled || busy} onClick={() => { void perform("rollback"); }}>恢复撤销前内容</button>}
      {state && canCancel(state) && <button type="button" disabled={disabled || busy} onClick={() => { void perform("cancel"); }}>取消未执行撤销</button>}
      {!state && <button type="button" disabled={disabled || busy} onClick={() => { void perform("cancel"); }}>取消未开始撤销</button>}
      {state && ["applied", "rolledBack"].includes(state.status) && <button type="button" disabled={disabled || busy} onClick={() => { void perform("save"); }}>重试保存撤销结果</button>}
    </div>
    {busy && <span>正在核对与处理…</span>}
  </section>;
}
function canContinue(state: AgentApplicationState): boolean {
  return state.status === "recoveryRequired" && state.files.some(file => file.phase === "pending")
    && state.files.every(file => file.phase === "pending" || file.phase === "acknowledged");
}
function canCancel(state: AgentApplicationState): boolean {
  return ["prepared", "applying", "recoveryRequired"].includes(state.status) && state.files.length > 0
    && state.files.every(file => file.phase === "pending");
}
