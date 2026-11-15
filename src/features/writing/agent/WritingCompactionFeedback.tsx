import { AgentSubmissionFeedback } from "@research-assistant/workbench-sdk/agent-submission";
import { AgentRecoveryMessage } from "@research-assistant/workbench-sdk/agent-presentation";
import { agentHistoryErrorMessage, writingPreparationSourceMessage } from "@research-assistant/workbench-sdk/agent-diagnostics";
import type { useWritingCompaction } from "./useWritingCompaction";
import {WritingCompactionAdmissionClosed} from "./writingCompactionAdmission";
import {decodeAgentSqlImmediateFailure} from "@research-assistant/core/agent";
import {writingPreparationDomainFields, writingQueueCancellationMessage} from "@research-assistant/workbench-sdk/agent-writing";

type Props = Pick<ReturnType<typeof useWritingCompaction>,
  "state" | "history" | "issue" | "restored" | "retry" | "dismiss" | "stop"> & Partial<Pick<ReturnType<typeof useWritingCompaction>, "queuedPending" | "queuedRecovery" | "settlement" | "manualPreparation" | "manualAdmission" | "queuedAdmission" | "queuedCancellation" | "queuedRetired" | "checkPreparation" | "discardPreparation">>;
const messages = {
  invalidInput: "压缩请求无效。",
  unbound: "原请求的稿件或会话绑定已不可用。",
  contextUnavailable: "原请求的来源暂不可用。",
  contextBudget: "原请求的来源超过可用上下文预算。",
  hostUnavailable: "原稿件或会话绑定暂不可用。",
  confirmationMismatch: "原请求的确认信息不匹配。",
  unsupportedModel: "原请求冻结的模型不支持压缩。",
  modelUnavailable: "原请求冻结的模型暂不可用。",
  historyChanged: "对话历史已改变，无法按原水位继续本次压缩。",
  busy: "当前会话已有任务，请核对原请求。",
  recoveryRequired: "执行结果尚未确认，请核对原压缩请求。",
  session: "读取原会话状态失败，请核对原请求。",
  notFound: "尚未找到原准备记录，请核对原请求。",
  conflict: "原请求已对应其他准备信息。",
  queue: "原队列状态尚待核对。",
  unavailable: "原请求的存储暂不可用。",
  DATA_RUNTIME_ADMISSION: "原请求的数据写入尚待恢复，执行终态未确认。",
  data_recovery_required: "原请求的数据恢复尚未完成，请核对原请求。",
  COMPACTION_MODEL_UNSUPPORTED: "原请求冻结的模型不支持当前执行模式。",
  COMPACTION_RECOVERY_RECEIPT_INVALID: "本地恢复记录无效，无法确认原压缩请求。",
  COMPACTION_RECOVERY_RECEIPT_SCOPE_MISMATCH: "本地恢复记录与当前稿件或会话不匹配。",
  COMPACTION_RECOVERY_RECEIPT_PENDING: "另一个原压缩请求尚待核对。",
  COMPACTION_RECOVERY_PERSISTENCE_FAILED: "本机恢复记录尚未可靠保存，请重试原操作的本机保存。",
  COMPACTION_QUEUE_CLAIM_MISMATCH: "原队列压缩身份已变化，请保留原请求并核对。",
  COMPACTION_QUEUE_CANCELLATION_PENDING: "Core 中的原取消记录尚待核对，请保留原压缩请求。",
  COMPACTION_RECOVERY_FULL_INTENT_MISSING: "旧记录缺少完整原准备意图，只能读取原冻结记录。",
  COMPACTION_PREPARE_UNCONFIRMED: "原压缩准备事务尚未确认。",
  COMPACTION_START_UNCONFIRMED: "原压缩启动尚未确认，请核对原请求。",
  COMPACTION_DRAFT_ACKNOWLEDGMENT_UNAVAILABLE: "本机草稿签收暂不可用，请保留原请求重试。",
  AGENT_PREVIEW_SYNTHETIC_IO_ACK_LOST: "原准备回执丢失，请核对原事务。",
  AGENT_PREVIEW_SYNTHETIC_IO_BEFORE_COMMIT: "原准备发送前断连，请核对原事务。",
  AGENT_PREVIEW_SCENARIO_CANCELED: "原场景等待已取消，请核对原请求。",
  AGENT_PREVIEW_OWNER_INTENT_MISSING: "原请求的归属尚无法确认，原请求和草稿已保留。",
} as const;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function writingCompactionDiagnostic(cause: unknown, conversationId?: string): string {
  if (cause instanceof WritingCompactionAdmissionClosed) {
    const fields = [`code=${cause.code}`, `step=${cause.step}`];
    for (const [label, value] of [["C", cause.identity.conversationId], ["M", cause.identity.manuscriptId], ["R", cause.identity.requestId]]) {
      if (uuid(value)) fields.push(`${label}=${value}`);
    }
    return `插件已停用，当前步骤尚未派发，原请求已保留。 [${fields.join("；")}]`;
  }
  const source = writingPreparationSourceMessage(cause);
  if (source !== undefined) return source;
  const row = record(cause);
  const domain = writingPreparationDomainFields(cause);
  if (domain) return `原准备事务尚待核对。 [${domain.join("；")}]`;
  const sql = decodeAgentSqlImmediateFailure(cause), detail = sql?.diagnostic ?? ((row?.code === "COMPACTION_PREPARE_UNCONFIRMED" || row?.code === "COMPACTION_START_UNCONFIRMED")
    ? decodeAgentSqlImmediateFailure({code: "DATA_SQL_RECOVERY_REQUIRED", reason: row.detail})?.diagnostic : undefined);
  if (sql || detail) {
    const fields = [`code=${sql?.code ?? row?.code ?? "COMPACTION_PREPARE_UNCONFIRMED"}`];
    if (detail) for (const field of ["operationId", "phase", "epoch", "sqlFence", "sqliteCode", "sqliteExtendedCode", "safeCause"] as const)
      if (detail[field] != null) fields.push(`${field}=${detail[field]}`);
    return `原准备事务尚待核对。 [${fields.join("；")}]`;
  }
  if (row?.code === "data_persistence_failed") return agentHistoryErrorMessage(cause, conversationId ?? "unknown");
  const code = typeof cause === "string" ? cause : typeof row?.code === "string" ? row.code : cause instanceof Error ? cause.message : undefined;
  if (typeof code !== "string" || !Object.hasOwn(messages, code)) return "操作结果尚未确认，请保留原请求并核对。（本机诊断码：COMPACTION_RESULT_UNCONFIRMED）";
  const message = messages[code as keyof typeof messages];
  const reason = record(row?.reason);
  const nested = code === "queue" && typeof reason?.code === "string" && Object.hasOwn(messages, reason.code) ? `；queue=${reason.code}` : "";
  const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const fence = code === "historyChanged" && revision(reason?.expected) && revision(reason?.actual)
    ? `；expected=${reason.expected}；actual=${reason.actual}` : "";
  return `${message}（错误码：${code}${nested}${fence}）`;
}
function uuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value) ? value : null;
}

/** Recovery controls only. Durable transcript facts display compaction activity. */
export function WritingCompactionFeedback({ state, history, issue, restored, retry, dismiss, stop, queuedPending, queuedRecovery, settlement, manualPreparation, manualAdmission, queuedAdmission, queuedCancellation, queuedRetired, checkPreparation, discardPreparation }: Props): React.JSX.Element | null {
  const historyFailed = history?.status === "error";
  const needsSettlement = queuedPending && state?.outcome != null;
  if (!issue && !historyFailed && !needsSettlement && state?.phase !== "preview" && !state?.error) return null;
  const frozen = state?.preview;
  const receipt = frozen ?? state?.recoveryReceipt ?? queuedRecovery ?? manualPreparation?.recovery;
  const conversationId = uuid(receipt?.conversationId ?? state?.request?.request.conversationId);
  const requestId = uuid(receipt?.requestId ?? state?.request?.request.requestId);
  const inputId = uuid(queuedRecovery?.inputId ?? frozen?.queued?.inputId), operationId = uuid(settlement?.request?.operationId ?? queuedRecovery?.queued.settle?.operationId);
  const pending = !!state && !state.outcome;
  const cancelPending = !!queuedCancellation && !["idle", "ready"].includes(queuedCancellation.phase);
  const confirm = state?.phase === "preview" && !cancelPending && !queuedRetired;
  const historyReadOnly = historyFailed && (confirm || state?.phase === "starting" || state?.phase === "started");
  const retryable = (queuedPending && (state?.outcome != null || !!issue)) || confirm || state?.error === "prepare" || state?.error === "start"
    || state?.cause instanceof WritingCompactionAdmissionClosed || (historyReadOnly && pending) || queuedRetired;
  const stoppable = !cancelPending && !queuedRetired && pending && !!frozen && !state.stopPending && !state.stopRequested
    && (state.phase === "starting" || state.phase === "started" || state.error === "start" || state.error === "stop");
  const historyRejected = restored && state?.error === "startRejected" && record(state.cause)?.code === "historyChanged";
  const manual = manualPreparation?.recovery, manualPrepareError = !!manual && state?.error === "prepare";
  const manualStarted = !!manual?.manual.start?.result;
  const manualStartRecovery = !!manual?.manual.draftAcknowledgment && (!!manual.manual.start || state?.error === "start") || manualAdmission?.blockedBeforeDispatch === "start";
  const manualLocal = !!manual?.manual.result && manualPreparation?.phase === "localError";
  const manualDiscard = !!manualAdmission?.blockedBeforeDispatch || !!queuedAdmission?.blockedBeforeDispatch || !manualStarted && !manualPreparation?.priorStartUnknown
    && (!!manual && !manualPreparation?.priorUnknown && manual.manual.knownRejected
      || !!manual && state?.error === "startRejected" && !(state.cause instanceof WritingCompactionAdmissionClosed));
  const dismissible = !queuedPending && !!state && (state.outcome !== null || historyRejected || (!restored
    && (confirm || state.error === "prepare" || state.error === "startRejected")));
  const stateDiagnostic = state?.error ? writingCompactionDiagnostic(state.cause, conversationId ?? undefined) : null;
  const issueDiagnostic = issue != null ? writingCompactionDiagnostic(issue, conversationId ?? undefined) : null;
  const controls = <>
    {confirm && <p>{restored ? "已恢复原压缩请求，确认后继续。" : "请确认原压缩请求。"}</p>}
    {frozen && <p>已冻结模型：{frozen.input.model.providerId}/{frozen.input.model.modelId}；历史水位：{frozen.expectedRevision}</p>}
    {historyFailed && (stateDiagnostic || issueDiagnostic) && <p>无法读取压缩历史，尚未确认执行是否结束。</p>}
    {!frozen && manual && <p>原历史水位：{manual.manual.prepare.expectedRevision}</p>}
    {state?.stopPending && <p role="status">正在发送停止请求，等待历史确认。</p>}
    {state?.stopRequested && <p role="status">已请求停止，等待历史确认。</p>}
    {cancelPending && <p role="status">{writingQueueCancellationMessage(queuedCancellation)}</p>}
    {queuedRetired && <p role="status">原未启动压缩已取消，正在核对本机清理。</p>}
    <div className="agent-failure-actions">
    {(manualPrepareError || queuedAdmission?.blockedBeforeDispatch === "prepare") && checkPreparation && <button type="button" onClick={() => {void checkPreparation();}}>核对原准备</button>}
    {manualStartRecovery && !manualStarted && checkPreparation && <button type="button" onClick={() => {void checkPreparation();}}>核对原启动</button>}
    {(retryable || manualLocal || !!manual && state?.outcome != null) && <button type="button" onClick={() => { void retry(); }}>
      {cancelPending || queuedRetired ? "核对原取消并重试清理" : queuedPending && state?.outcome ? "核对原队列压缩收尾" : historyReadOnly ? "重新读取原请求历史"
        : manualLocal ? manualStarted ? "重试本机签收" : "重试本机收尾" : confirm ? "确认并继续原压缩请求" : manualPrepareError ? "重试原准备并继续" : state?.error === "prepare" ? "核对原准备记录并继续" : "核对原压缩请求"}
    </button>}
    {stoppable && <button type="button" onClick={() => { void stop(); }}>停止原压缩请求</button>}
    {manualDiscard && !queuedRetired && discardPreparation && <button type="button" onClick={() => {void discardPreparation();}}>放弃原准备</button>}
    {dismissible && !manual && <button type="button" onClick={() => { dismiss(); }}>{historyRejected ? "放弃原压缩请求" : "关闭提示"}</button>}
    </div>
  </>;
  if (confirm && !stateDiagnostic && !issueDiagnostic && !historyFailed) return <AgentSubmissionFeedback label="上下文压缩恢复">{controls}</AgentSubmissionFeedback>;
  const diagnostic = [stateDiagnostic, issueDiagnostic !== stateDiagnostic ? issueDiagnostic : null,
    historyFailed ? writingCompactionDiagnostic(history.error, conversationId ?? undefined) : null,
    conversationId && `C=${conversationId}`, requestId && `R=${requestId}`, inputId && `I=${inputId}`, operationId && `E=${operationId}`,
    uuid(queuedCancellation?.intent?.requestId) && `O=${queuedCancellation?.intent?.requestId}`].filter(Boolean).join("\n");
  const summary = (stateDiagnostic ?? issueDiagnostic)?.replace(/\s*\[.*$/u, "").replace(/（(?:错误码|本机诊断码)：.*$/u, "")
    ?? (historyFailed ? "无法读取压缩历史，尚未确认执行是否结束。" : "上下文压缩尚待处理，请检查后继续。");
  return <AgentRecoveryMessage id="compaction-recovery" label="上下文压缩恢复" content={summary} diagnosticText={diagnostic}>
    {controls}
  </AgentRecoveryMessage>;
}
