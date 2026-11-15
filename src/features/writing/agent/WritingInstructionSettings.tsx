import { useNotificationState } from "@research-assistant/workbench-sdk/feedback";
import { useEffect, useRef, useState } from "react";
import type { AgentInstructionTrust } from "@research-assistant/core/agent";
import { agentInstructionTrustGateway as gateway } from "@research-assistant/workbench-sdk/agent-gateways";

export function WritingInstructionSettings({ manuscriptId }: { readonly manuscriptId: string }) {
  return <ScopedInstructionSettings key={manuscriptId} manuscriptId={manuscriptId} />;
}
function ScopedInstructionSettings({ manuscriptId }: { readonly manuscriptId: string }) {
  const [state, setState] = useState<AgentInstructionTrust>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useNotificationState("error");
  const [, setNotice] = useNotificationState("info");
  const generation = useRef(0);
  async function reload() {
    const current = ++generation.current;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { const next = await gateway.read(manuscriptId); if (current === generation.current) setState(next); }
    catch { if (current === generation.current) setError("无法读取项目指令设置。请在桌面应用中重试。"); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => { void reload(); return () => { generation.current++; }; }, [manuscriptId]);
  async function update(granted: boolean) {
    if (!state || busy || error) return;
    const current = ++generation.current;
    setBusy(true); setNotice(undefined);
    try {
      const next = await gateway.update(manuscriptId, state.revision, granted);
      if (current === generation.current) { setState(next); setNotice(granted ? "已允许加载项目指令。" : "已停止加载新的项目指令。"); }
    } catch { if (current === generation.current) setError("设置结果尚未确认，请重新读取当前状态后再操作。"); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <>
    <h3>项目指令</h3>
    <p>允许 Agent 在准备提交时读取当前稿件的 AGENTS.md、AGENTS.override.md 及 .agents/skills/ 技能目录，并在发送预览中显示指令和技能元数据。</p>
    <label><span><strong>信任此稿件的项目指令</strong><small>只影响指令加载，不授予命令执行、网络或文件修改权限。发送仍需确认。</small></span>
      <input type="checkbox" role="switch" aria-label="信任此稿件的项目指令" checked={state?.granted ?? false} disabled={busy || !!error || !state} onChange={(event) => void update(event.target.checked)} /></label>
    {state?.granted && !state.rootMatches && <p role="alert">稿件目录已变化或不可用，现有授权已失效。可以关闭授权，或在目录恢复后重新信任。</p>}
    {state?.granted && !state.rootMatches && <button type="button" disabled={busy || !!error} onClick={() => void update(true)}>重新信任当前目录</button>}
    <p>关闭后，新提交不再加载项目指令；已保存的提交预览和历史保留原指令快照。</p>
    {busy && <p role="status">正在读取或保存设置…</p>}


    <button type="button" disabled={busy} onClick={() => void reload()}>重新读取状态</button>
  </>;
}
