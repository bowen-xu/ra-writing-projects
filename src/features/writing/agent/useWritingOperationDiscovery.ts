import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentApplicationScope, AgentPendingWritingApplicationRequest } from "@research-assistant/core/agent";

interface Identity { readonly scope: AgentApplicationScope }
export interface WritingOperationPage<Entry> { readonly items: readonly Entry[]; readonly nextCursor: number | null }

/** Read-only journal projection. Commands retain newer observations; this hook
 * neither executes operations nor infers receipts from editor text. */
export function useWritingOperationDiscovery<Entry extends Identity>(manuscriptId: string | undefined,
  workspaceIdentity: unknown, readPage: (request: AgentPendingWritingApplicationRequest) => Promise<WritingOperationPage<Entry>>,
  key: (entry: Entry) => string) {
  const [store, setStore] = useState<{ owner: unknown; entries: readonly Entry[] }>({ owner: readPage, entries: [] });
  const [retry, setRetry] = useState(0);
  const [scan, setScan] = useState<{ manuscriptId: string; readPage: typeof readPage; owner: unknown; retry: number; failed: boolean } | null>(null);
  // Retirement reads the same objects published to React, including batched actions.
  const liveStore = useRef(store), liveScan = useRef(scan), liveRetry = useRef(retry);
  const publishStore = useCallback((update: (previous: typeof store) => typeof store) => {
    const next = update(liveStore.current); liveStore.current = next; setStore(next);
  }, []);
  const publishScan = useCallback((next: typeof scan) => {liveScan.current = next; setScan(next);}, []);
  const changedDuringScan = useRef<Set<string> | null>(null);
  const alive = useRef(false), latest = useRef({ manuscriptId, workspaceIdentity, readPage }); latest.current = { manuscriptId, workspaceIdentity, readPage };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const observe = useCallback((entry: Entry) => {
    if (!alive.current || latest.current.workspaceIdentity !== workspaceIdentity || latest.current.readPage !== readPage || entry.scope.manuscriptId !== latest.current.manuscriptId) return;
    const id = key(entry); changedDuringScan.current?.add(id);
    publishStore(previous => ({ owner: readPage,
      entries: [...(previous.owner === readPage ? previous.entries : []).filter(item => key(item) !== id), entry] }));
  }, [workspaceIdentity, key, readPage, publishStore]);
  const dismiss = useCallback((entry: Entry) => {
    if (!alive.current || latest.current.workspaceIdentity !== workspaceIdentity || latest.current.readPage !== readPage || entry.scope.manuscriptId !== latest.current.manuscriptId) return;
    const id = key(entry); changedDuringScan.current?.add(id);
    publishStore(previous => ({ owner: readPage,
      entries: (previous.owner === readPage ? previous.entries : []).filter(item => key(item) !== id) }));
  }, [workspaceIdentity, key, readPage, publishStore]);
  useEffect(() => {
    if (!manuscriptId) return;
    let current = true;
    const changed = new Set<string>(); changedDuringScan.current = changed;
    void (async () => {
      try {
        let after: number | null = null;
        const seen = new Set<string>();
        do {
          const page = await readPage({ manuscriptId, after, limit: 64 });
          if (!current) return;
          for (const entry of page.items) {
            const id = key(entry);
            if (entry.scope.manuscriptId !== manuscriptId || seen.has(id)) throw new Error("文件操作发现身份无效");
            seen.add(id);
          }
          if (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= (after ?? 0))) throw new Error("文件操作发现分页无效");
          publishStore(previous => {
            const entries = previous.owner === readPage ? previous.entries : [];
            return { owner: readPage, entries: [...entries, ...page.items.filter(entry => !changed.has(key(entry))
              && !entries.some(item => key(item) === key(entry)))] };
          });
          after = page.nextCursor;
        } while (after !== null);
        publishScan({ manuscriptId, readPage, owner: workspaceIdentity, retry, failed: false });
      } catch {
        if (current) publishScan({ manuscriptId, readPage, owner: workspaceIdentity, retry, failed: true });
      } finally { if (changedDuringScan.current === changed) changedDuringScan.current = null; }
    })();
    return () => { current = false; if (changedDuringScan.current === changed) changedDuringScan.current = null; };
  }, [manuscriptId, readPage, workspaceIdentity, retry, key, publishStore, publishScan]);
  const scanned = scan !== null && scan.manuscriptId === manuscriptId && scan.readPage === readPage
    && scan.owner === workspaceIdentity && scan.retry === retry;
  const loading = !!manuscriptId && !scanned, failed = !!manuscriptId && scanned && !!scan?.failed;
  const entries = store.owner === readPage ? store.entries.filter(entry => entry.scope.manuscriptId === manuscriptId) : [];
  const hasPending = useCallback(() => {
    const current = latest.current, observed = liveScan.current, stored = liveStore.current;
    if (!current.manuscriptId) return false;
    return observed === null || observed.manuscriptId !== current.manuscriptId || observed.readPage !== current.readPage
      || observed.owner !== current.workspaceIdentity || observed.retry !== liveRetry.current || observed.failed
      || (stored.owner === current.readPage && stored.entries.some(entry => entry.scope.manuscriptId === current.manuscriptId));
  }, []);
  return { entries, observe, dismiss, loading, failed, pending: loading || failed || entries.length > 0, hasPending,
    retry: () => {liveRetry.current++; setRetry(liveRetry.current);} };
}
