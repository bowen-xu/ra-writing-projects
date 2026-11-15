import { useEffect, useRef, useState } from "react";
import type { AgentWorkspaceDiscardConfirmation, AgentWorkspaceDiscardPreview, AgentWorkspaceDiscardRecovery, AgentWorkspaceScope } from "@research-assistant/core/agent";
import { agentWorkspaceDiscardGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import type { AgentWorkspaceDiscardGateway } from "@research-assistant/data/agent";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import "./WritingWorkspaceReview.css";

interface Props { readonly scope: AgentWorkspaceScope; readonly disabled: boolean; readonly onClose: () => void; readonly gateway?: AgentWorkspaceDiscardGateway }
const kinds = { added: "新增", modified: "修改", deleted: "删除" };
function confirmation(value: AgentWorkspaceDiscardConfirmation): AgentWorkspaceDiscardConfirmation {
  return { operationId: value.operationId, binding: value.binding, environmentId: value.environmentId, inventoryHash: value.inventoryHash };
}

/** One explicit cleanup flow; closing never grants or revokes native ownership. */
export function WritingWorkspaceDiscard(props: Props): React.JSX.Element {
  const { scope, disabled, onClose } = props;
  const workspaceGateway = props.gateway ?? agentWorkspaceDiscardGateway;
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const attempted = useRef<AgentWorkspaceDiscardConfirmation | null>(null);
  const [preview, setPreview] = useState<AgentWorkspaceDiscardPreview | null>(null);
  const [record, setRecord] = useState<AgentWorkspaceDiscardRecovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [shown, setShown] = useState(100);
  function close(): void { dialog.current?.close(); onClose(); }
  useEffect(() => {
    const element = dialog.current; element?.showModal();
    void refresh();
    return () => { generation.current++; pending.current = false; element?.close(); };
  }, []);
  async function refresh(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    const ticket = ++generation.current;
    setLoading(true); setMessage(null); setShown(100);
    try {
      const saved = await workspaceGateway.find(scope);
      if (ticket !== generation.current) return;
      const current = !saved && !attempted.current ? await workspaceGateway.preview(scope) : null;
      if (ticket !== generation.current) return;
      setRecord(saved); setPreview(current);
      if (saved) { attempted.current = confirmation(saved); setUncertain(saved.state === "pending"); }
      else if (current) setUncertain(false);
    } catch {
      if (ticket === generation.current) {
        setPreview(null); setRecord(null);
        setMessage("无法核对副本状态。请确认稿件仍可用且命令已结束，再刷新重试。");
      }
    } finally { if (ticket === generation.current) { pending.current = false; setLoading(false); } }
  }
  async function discard(): Promise<void> {
    const request = record ? confirmation(record) : attempted.current ?? preview?.confirmation;
    if (!request || disabled || pending.current || record?.state === "complete") return;
    pending.current = true; attempted.current = request;
    const ticket = ++generation.current;
    setBusy(true); setMessage(null);
    try {
      const result = await workspaceGateway.discard(request);
      if (ticket === generation.current) {
        setRecord(result); setPreview(null); setUncertain(false);
        notify.success("执行副本已丢弃，原稿和已保存提案仍保留。");
      }
    } catch (error) {
      if (ticket === generation.current) {
        setUncertain(true);
        if (error === "busy" || error === "conflict") {
          // A terminal native refusal can be re-previewed after checking the
          // durable journal. Transport failures retain the original operation.
          attempted.current = null; setPreview(null); setRecord(null);
        }
        setMessage(error === "busy" ? "会话或副本正在使用中，请结束当前操作后核对并重试。"
          : error === "conflict" ? "确认版本已变化。请刷新核对；若清理已开始，只能继续原操作。"
          : "清理结果尚未确认。请刷新核对状态或重试原清理，不要重新执行 Agent 命令。");
      }
    } finally { if (ticket === generation.current) { pending.current = false; setBusy(false); } }
  }
  const complete = record?.state === "complete";
  const recovery = uncertain || record?.state === "pending";
  const hasRequest = !!(record || attempted.current || preview);
  return <dialog className="writing-workspace-review writing-workspace-discard" ref={dialog} aria-label="管理执行副本"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <header><h2>管理执行副本</h2><button type="button" onClick={close}>关闭</button></header>
    <p>仅清理 Agent 的私有执行副本。原稿、编辑器草稿和已保存提案不受影响。</p>
    {disabled && <p role="status">请先结束当前运行或处理提交，再丢弃副本。</p>}
    {loading && <p role="status">正在核对副本与清理记录…</p>}
    {busy && <p role="status">正在丢弃副本…关闭窗口后清理仍会继续。</p>}
    {message && <p role="alert">{message}</p>}
    {complete ? <p role="status">清理记录显示已完成。已保存提案仍可回看和按原规则应用。</p> : <>
      {recovery && <p>原清理尚待完整确认，部分文件可能已移除。继续使用同一操作，关闭窗口不会撤销已发生的清理。</p>}
      {preview && !recovery && <>
        <p>当前副本有 {preview.review.changes.length} 个变更文件。尚未保存为提案的副本内容将永久删除；需要保留时请选择“保留副本”。已经进入编辑器的文件修改不受影响。</p>
        <ul aria-label="将丢弃的副本变更">{preview.review.changes.slice(0, shown).map(change =>
          <li key={change.path}>{kinds[change.kind]} · {change.path}</li>)}</ul>
        {shown < preview.review.changes.length && <button type="button" onClick={() => setShown(value => value + 100)}>显示更多变更</button>}
      </>}
      {hasRequest && !loading && <button type="button" disabled={disabled || busy || !!message && !recovery}
        onClick={() => void discard()}>{busy ? "正在丢弃…" : recovery ? "重试原清理" : "确认丢弃副本"}</button>}
    </>}
    <footer>
      {!complete && <button type="button" disabled={busy} onClick={close}>{recovery ? "暂不继续" : "保留副本"}</button>}
      <button type="button" disabled={loading || busy} onClick={() => void refresh()}>刷新清理状态</button>
    </footer>
  </dialog>;
}
