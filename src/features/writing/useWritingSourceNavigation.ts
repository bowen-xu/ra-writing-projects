import { useEffect, useRef } from "react";
import type { WritingSourceNavigation } from "@research-assistant/workbench-sdk/source-navigation";
import type { WritingFocusRequest } from "./sourceNavigation";

export function useWritingSourceNavigation(request: WritingSourceNavigation | undefined, manuscriptId: string | undefined,
  ready: boolean, selectFile: (path: string) => Promise<boolean>, focus: (request: WritingFocusRequest & { readonly path: string }) => void) {
  const current = useRef({ selectFile, focus }); current.current = { selectFile, focus };
  const owner = useRef({ request, manuscriptId }); owner.current = { request, manuscriptId };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const handled = useRef<WritingSourceNavigation | undefined>(undefined);
  useEffect(() => {
    if (!request || request.manuscriptId !== manuscriptId || !ready || handled.current === request) return;
    handled.current = request;
    void (async () => {
      if (!await current.current.selectFile(request.path)) throw new Error("无法打开来源文件，请先保存或解决当前稿件冲突");
      if (!mounted.current || owner.current.request !== request || owner.current.manuscriptId !== manuscriptId) throw new Error("来源导航已被新请求取代");
      if (!request.locator && !request.locate) {request.resolve(); return;}
      const range = request.locator?.range;
      current.current.focus({ path: request.path, line: range?.startLine ?? 1, token: request.token,
        ...(request.locator?.kind === "block" ? {blockId: request.locator.blockId} : {}),
        ...(range ? { range } : {}), onLocated: request.resolve, onError: request.reject });
    })().catch(request.reject);
  }, [request, manuscriptId, ready]);
}
