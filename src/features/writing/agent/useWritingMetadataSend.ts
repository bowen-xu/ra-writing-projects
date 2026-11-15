import { useEffect, useRef, useState } from "react";
import { notify } from "@research-assistant/workbench-sdk/feedback";

/** Only an explicit send waits for metadata. Failures retain the composer and
 * terminate that send; a later click checks again instead of replaying it. */
export function useWritingMetadataSend<Request extends readonly unknown[]>({loading, issue, ready, active, retry, send}: {
  readonly loading: boolean;
  readonly issue: string | undefined;
  readonly ready: boolean;
  readonly active: boolean;
  readonly retry: (() => void) | undefined;
  readonly send: (...request: Request) => Promise<void>;
}) {
  const pending = useRef<Request | null>(null);
  const [waiting, setWaiting] = useState(false);
  const latest = useRef(send); latest.current = send;
  const lastError = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    if (loading || !issue) { lastError.current = undefined; return; }
    if (lastError.current === issue) return;
    lastError.current = issue;
    notify.error(`${issue} 消息已保留在输入框中，请重新发送。`);
  }, [loading, issue, active]);
  useEffect(() => {
    if (!active) { pending.current = null; setWaiting(false); return; }
    if (!waiting || loading || (!issue && !ready)) return;
    const request = pending.current;
    pending.current = null; setWaiting(false);
    if (request && !issue) void latest.current(...request);
  }, [waiting, loading, ready, issue, active]);
  useEffect(() => () => { pending.current = null; }, []);
  function wait(request: Request, force = false): boolean {
    if (!force && !loading && !issue) return false;
    if (pending.current) return true;
    if (issue && !retry) { notify.error(`${issue} 消息已保留，请稍后重试。`); return true; }
    pending.current = request; setWaiting(true);
    if (issue) retry?.();
    return true;
  }
  function cancel(): void { pending.current = null; setWaiting(false); }
  useEffect(() => {
    if (!waiting || !active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [waiting, active]);
  return {waiting, wait, cancel};
}
