import { useEffect, useState } from "react";
import type { AgentQueueAdmission, AgentQueueAdmissionsPage } from "@research-assistant/core/agent";
import { agentQueueAdmissionsGateway } from "../../../../../../apps/web/src/core/public/agent";
import type { AgentQueueAdmissionsGateway } from "@research-assistant/data/agent";
import { useAgentRequestGuard } from "../../../../../../apps/web/src/core/public/agentPresentation/useAgentMountedGuard";
interface Props {
  readonly conversationId: string;
  readonly manuscriptId: string;
  readonly disabled: boolean;
  readonly onReview: (item: AgentQueueAdmission) => void;
  readonly gateway?: AgentQueueAdmissionsGateway;
}
/** Parent scopes this component to a single conversation. Listing never starts work. */
export function WritingUnstartedAdmissions(props: Props): React.JSX.Element {
  const queueGateway = props.gateway ?? agentQueueAdmissionsGateway;
  const [open, setOpen] = useState(false);
  const [after, setAfter] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const beginRequest = useAgentRequestGuard();
  const [state, setState] = useState<{ page: AgentQueueAdmissionsPage | null; error: boolean; loading: boolean }>({ page: null, error: false, loading: false });
  useEffect(() => {
    if (!open || props.disabled) return;
    const active = beginRequest();
    setState({ page: null, error: false, loading: true });
    void queueGateway.list({ conversationId: props.conversationId, manuscriptId: props.manuscriptId, after, limit: 20 })
      .then((page) => { if (active()) setState({ page, error: false, loading: false }); })
      .catch(() => { if (active()) setState({ page: null, error: true, loading: false }); });
  }, [beginRequest, open, props.disabled, props.conversationId, props.manuscriptId, after, retry]);
  return <section className="writing-agent-submission" aria-label="未启动提交恢复">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>检查未启动的提交</button>
    {open && <>
      <p>这些消息已接纳，但未发现启动记录。查看原内容后可重新确认；不会重新入队或自动发送。</p>
      {props.disabled ? <p role="status">请先处理当前运行或预览。</p> : <>
        {state.loading && <p role="status">正在读取…</p>}
        {state.error && <p role="alert">读取失败，请重试。原记录仍保留。</p>}
        {!state.loading && !state.error && state.page?.items.length === 0 && <p>本页没有未启动的提交。</p>}
        {state.page?.items.map((item) => <div key={item.inputId}>
          <p>{item.preview.input.text}</p>
          <button type="button" onClick={() => props.onReview(item)}>查看原提交</button>
        </div>)}
        <button type="button" disabled={state.loading} onClick={() => setRetry((value) => value + 1)}>刷新本页</button>
        {after && <button type="button" disabled={state.loading} onClick={() => setAfter(null)}>返回第一页</button>}
        {state.page?.nextCursor && <button type="button" disabled={state.loading} onClick={() => setAfter(state.page?.nextCursor ?? null)}>下一页</button>}
      </>}
    </>}
  </section>;
}
