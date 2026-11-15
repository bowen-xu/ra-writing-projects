import { useCallback, useEffect, useRef, useState } from "react";
import type { WritingGateway } from "../gateway";
import type { PendingFileConflict } from "../useWritingPersistence";
import type { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import { NotificationEffect } from "@research-assistant/workbench-sdk/feedback";

/** Readiness only; the existing file sessions and checkpoint queue own all text. */
export function useWritingBackgroundRecovery(options: {
  readonly manuscriptId: string | undefined;
  readonly ready: boolean;
  readonly gateway: Pick<WritingGateway, "readFile">;
  readonly checkpoints: WritingCheckpointPersistence;
  readonly onFileConflict: (conflict: PendingFileConflict) => void;
}) {
  const latest = useRef(options); latest.current = options;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ manuscriptId: string; gateway: typeof options.gateway;
    checkpoints: WritingCheckpointPersistence; retry: number; failed: boolean } | null>(null);
  const liveResult = useRef(result), liveRetry = useRef(retry);
  const publishResult = useCallback((next: typeof result) => {liveResult.current = next; setResult(next);}, []);
  const matches = result !== null && result.manuscriptId === options.manuscriptId && result.gateway === options.gateway
    && result.checkpoints === options.checkpoints && result.retry === retry;
  useEffect(() => {
    const { manuscriptId, gateway, checkpoints } = options;
    if (!manuscriptId || !options.ready || matches) return;
    let active = true;
    const current = () => active && latest.current.manuscriptId === manuscriptId && latest.current.ready
      && latest.current.gateway === gateway && latest.current.checkpoints === checkpoints;
    void checkpoints.restoreBackground(manuscriptId, path => gateway.readFile(manuscriptId, path), current,
      snapshot => latest.current.onFileConflict({ manuscriptId, relativePath: snapshot.relativePath, bufferedContent: snapshot.content }))
      .then(() => { if (current()) publishResult({ manuscriptId, gateway, checkpoints, retry, failed: false }); })
      .catch(() => { if (active) publishResult({ manuscriptId, gateway, checkpoints, retry, failed: true }); });
    return () => { active = false; };
  }, [options.manuscriptId, options.ready, options.gateway, options.checkpoints, retry, matches, publishResult]);
  const pending = !!options.manuscriptId && (!matches || result?.failed === true);
  const hasPending = () => {
    const current = latest.current, observed = liveResult.current;
    return !!current.manuscriptId && (observed === null || observed.manuscriptId !== current.manuscriptId
      || observed.gateway !== current.gateway || observed.checkpoints !== current.checkpoints
      || observed.retry !== liveRetry.current || observed.failed);
  };
  return { pending, hasPending, ready: !pending, feedback: matches && result?.failed && <div className="writing-file-recovery-actions" role="group" aria-label="恢复后台文件">
    <NotificationEffect id={`writing-background-recovery:${options.manuscriptId}`} message="后台文件恢复尚未完成，当前内容已保留。完成核对前暂停 Agent 文件修改。" />
    <button type="button" disabled={!options.ready} onClick={() => {liveRetry.current++; setRetry(liveRetry.current);}}>重新读取文件检查点</button>
  </div> };
}
