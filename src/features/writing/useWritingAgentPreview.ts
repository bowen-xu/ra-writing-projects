import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConversationProjection } from "@research-assistant/core/agent";
import type { SynctexPdfLocation, SynctexSourceLocation } from "@research-assistant/writing";
import { agentCompileResultGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { latestAgentCompileResult } from "./preview/latestAgentCompileResult";
import type { PdfReadingPosition } from "./preview/writingPdfCoordinates";
import type { WritingSyncActions } from "./WritingDivider";
import { errorMessage } from "./workspaceState";

interface Options {
  readonly projection: AgentConversationProjection | null;
  readonly activeManuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly content: string;
  readonly cursorOffsets: Readonly<Record<string, number>>;
  readonly compiler: { readonly isPdfStale: boolean };
  readonly layout: { readonly reveal: (pane: "editor" | "preview") => void };
  readonly focusSourceLocation: (location: Pick<SynctexSourceLocation, "relativePath" | "line">, isCurrent?: () => boolean) => Promise<void>;
}

/** Agent compile previews remain read-only and separate from formal manuscript compilation. */
export function useWritingAgentPreview({ projection, activeManuscriptId, activePath, content, cursorOffsets, compiler, layout, focusSourceLocation }: Options) {
  const latestAgentResult = latestAgentCompileResult(projection, activeManuscriptId ?? "");
  const [agentPdfVisible, setAgentPdfVisible] = useState(false);
  const [agentPdfReadingPosition, setAgentPdfReadingPosition] = useState<PdfReadingPosition>();
  const [agentSynctexLocation, setAgentSynctexLocation] = useState<(SynctexPdfLocation & { readonly token: number })>();
  const [agentSyncBusy, setAgentSyncBusy] = useState(false);
  const agentInverseEpoch = useRef(0);
  useEffect(() => { agentInverseEpoch.current += 1; }, [activeManuscriptId, latestAgentResult?.resultId]);
  const handleAgentInverseSearch = useCallback(async (result: import("@research-assistant/core/agent").AgentCompileResult, page: number, x: number, y: number): Promise<void> => {
    const epoch = ++agentInverseEpoch.current;
    const isCurrent = (): boolean => agentInverseEpoch.current === epoch && latestAgentResult?.resultId === result.resultId;
    try {
      const matches = await agentCompileResultGateway.inverseSynctex(result, page, x, y);
      if (!isCurrent()) return;
      const match = matches[0];
      if (!match) { notify.error("没有找到此 Agent PDF 位置对应的源码"); return; }
      await focusSourceLocation(match, isCurrent);
    } catch (reason: unknown) {
      if (isCurrent()) notify.error(String(reason));
    }
  }, [activeManuscriptId, focusSourceLocation, latestAgentResult?.resultId]);
  const handleAgentForwardSearch = useCallback(async (result: import("@research-assistant/core/agent").AgentCompileResult): Promise<(SynctexPdfLocation & { readonly token: number }) | undefined> => {
    if (!activePath) { notify.error("请先打开源码文件"); return undefined; }
    const offset = cursorOffsets[activePath] ?? content.length;
    const before = content.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - (before.lastIndexOf("\n") + 1);
    const matches = await agentCompileResultGateway.forwardSynctex(result, activePath, line, column);
    if (latestAgentResult?.resultId !== result.resultId) return undefined;
    const match = matches[0];
    if (!match) { notify.error("没有找到此源码位置对应的 Agent PDF 内容"); return undefined; }
    return { ...match, token: Date.now() };
  }, [activePath, content, cursorOffsets, latestAgentResult?.resultId]);
  useEffect(() => {
    setAgentSynctexLocation(undefined);
    setAgentSyncBusy(false);
  }, [activeManuscriptId, latestAgentResult?.resultId]);
  const agentDividerSync: WritingSyncActions | undefined = agentPdfVisible && latestAgentResult
    ? {
      forwardDisabled: compiler.isPdfStale ? "源码已修改，请重新编译后定位" : agentSyncBusy ? "正在定位…" : undefined,
      backwardDisabled: compiler.isPdfStale ? "源码已修改，请重新编译后定位" : !agentPdfReadingPosition ? "请先查看 Agent PDF 页面" : agentSyncBusy ? "正在定位…" : undefined,
      forward: () => {
        if (agentSyncBusy || compiler.isPdfStale || !activePath) return;
        setAgentSyncBusy(true);
        void handleAgentForwardSearch(latestAgentResult)
          .then((location) => { if (location) { setAgentSynctexLocation(location); layout.reveal("preview"); } })
          .catch((reason: unknown) => notify.error(errorMessage(reason)))
          .finally(() => setAgentSyncBusy(false));
      },
      backward: () => {
        if (agentSyncBusy || compiler.isPdfStale || !agentPdfReadingPosition) return;
        setAgentSyncBusy(true);
        void handleAgentInverseSearch(latestAgentResult, agentPdfReadingPosition.page, agentPdfReadingPosition.x, agentPdfReadingPosition.y)
          .finally(() => setAgentSyncBusy(false));
      },
    }
    : undefined;

  return { latestAgentResult, handleAgentInverseSearch, handleAgentForwardSearch, agentDividerSync,
    setAgentPdfVisible, setAgentPdfReadingPosition, agentSyncBusy, setAgentSyncBusy, agentSynctexLocation, setAgentSynctexLocation };
}
