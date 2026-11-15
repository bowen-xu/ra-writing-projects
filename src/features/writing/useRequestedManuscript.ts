import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Manuscript } from "@research-assistant/writing";
import type { createExclusiveWritingGateway } from "./gateway/exclusiveWritingGateway";
import { errorMessage } from "./workspaceState";

interface Options {
  readonly requestId: string | undefined;
  readonly requestKey?: number;
  readonly access: ReturnType<typeof createExclusiveWritingGateway>;
  readonly saveCurrent: () => Promise<boolean>;
  readonly onOpen: (id: string, manuscripts: readonly Manuscript[]) => void;
  readonly onConsumed: () => void;
  readonly onError: (message: string) => void;
  readonly onFailure?: (message?: string) => void;
  readonly isCurrent?: () => boolean;
}

/** External navigation stays pending during proposal ownership. Only the newest
 * request may commit, after current work is saved and the ownership is rechecked.
 */
export function useRequestedManuscript(options: Options): void {
  const current = useRef(options);
  current.current = options;
  const {requestId, requestKey, access} = options;
  const blocked = useSyncExternalStore(access.subscribe, access.isExclusive, access.isExclusive);
  useEffect(() => {
    if (requestId === undefined || blocked) return;
    const targetId = requestId;
    let active = true;
    const owns = () => active && current.current.requestId === targetId && current.current.requestKey === requestKey && (current.current.isCurrent?.() ?? true) && !access.isExclusive();
    async function open(): Promise<void> {
      try {
        const items = await access.gateway.listManuscripts();
        if (!owns()) return;
        if (!items.some(item => item.id === targetId)) throw new Error("找不到引用的稿件");
        const saved = await current.current.saveCurrent();
        if (!owns()) return;
        if (!saved) { current.current.onFailure?.(); return; }
        current.current.onOpen(targetId, items);
        current.current.onConsumed();
      } catch (reason) { if (owns()) {
        const message = errorMessage(reason);
        if (current.current.onFailure) current.current.onFailure(message); else current.current.onError(message);
      } }
    }
    void open();
    return () => { active = false; };
  }, [requestId, requestKey, access, blocked]);
}
