import { useEffect, useState } from "react";
import type { AgentWorkspaceHistoryPage } from "@research-assistant/core/agent";
import { agentWorkspaceReviewGateway } from "../../../../../../apps/web/src/core/public/agent";
import { WritingWorkspaceReview } from "./WritingWorkspaceReview";
import type { AgentWorkspaceReviewGateway } from "@research-assistant/data/agent";
import type { AgentWorkspaceDiscardGateway } from "@research-assistant/data/agent";
interface Props {
  readonly conversationId: string;
  readonly manuscriptId: string;
  readonly disabled: boolean;
  readonly turnOrder: readonly string[];
  readonly workspaceReviewGateway?: AgentWorkspaceReviewGateway;
  readonly workspaceDiscardGateway?: AgentWorkspaceDiscardGateway;
}
/** Parent keys this view by conversation/manuscript, independently of preview. */
export function WritingWorkspaceHistory(props: Props): React.JSX.Element {
  const workspaceGateway = props.workspaceReviewGateway ?? agentWorkspaceReviewGateway;
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ page: AgentWorkspaceHistoryPage | null; loading: boolean; error: boolean }>({ page: null, loading: false, error: false });
  useEffect(() => {
    if (!open || props.disabled) return;
    let live = true;
    setState({ page: null, loading: true, error: false });
    void workspaceGateway.list({ conversationId: props.conversationId, manuscriptId: props.manuscriptId, cursor, limit: 20 })
      .then((page) => { if (live) setState({ page, loading: false, error: false }); })
      .catch(() => { if (live) setState({ page: null, loading: false, error: true }); });
    return () => { live = false; };
  }, [open, props.disabled, props.conversationId, props.manuscriptId, cursor, retry]);
  return <section className="writing-agent-submission" aria-label="历史副本变更">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>历史副本变更</button>
    {open && <>
      {props.disabled ? <p role="status">请先处理当前运行或提交。</p> : <>
        <p>查看本对话的修改文件与副本清理记录。点击文件名打开当前资源，不会重新执行命令或应用历史修改。</p>
        {state.loading && <p role="status">正在读取历史副本…</p>}
        {state.error && <p role="alert">读取失败，请刷新或返回第一页。原副本仍保留。</p>}
        {state.page?.entries.length === 0 && <p>本页没有副本记录。</p>}
        {state.page?.entries.map((entry) => {
          const index = props.turnOrder.indexOf(entry.turnId);
          const label = index >= 0 ? `第 ${index + 1} 轮` : `提交 ${entry.scope.requestId.slice(0, 8)}`;
          return <div key={entry.scope.requestId}>
            <p>{label} · <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></p>
            <WritingWorkspaceReview scope={entry.scope} disabled={false} workspaceReviewGateway={workspaceGateway}
              {...(props.workspaceDiscardGateway === undefined ? {} : { workspaceDiscardGateway: props.workspaceDiscardGateway })}
              label={`查看${label}副本变更`} />
          </div>;
        })}
        <button type="button" disabled={state.loading} onClick={() => setRetry((value) => value + 1)}>刷新副本列表</button>
        {cursor && <button type="button" disabled={state.loading} onClick={() => setCursor(null)}>返回第一页</button>}
        {state.page?.nextCursor && <button type="button" disabled={state.loading} onClick={() => setCursor(state.page?.nextCursor ?? null)}>下一页</button>}
      </>}
    </>}
  </section>;
}
