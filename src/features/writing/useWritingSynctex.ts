import { useCallback, useEffect, useRef, useState } from "react";
import type { CompileRun, LatexToolchainInfo, SynctexPdfLocation, SynctexSourceLocation } from "@research-assistant/writing";
import type { WritingGateway } from "./gateway";
import type { PdfReadingPosition } from "./preview/writingPdfCoordinates";
import { errorMessage } from "./workspaceState";

interface Options {
  readonly displayedPdfRevision: string | undefined;
  readonly manuscriptId: string | undefined;
  readonly run: CompileRun | undefined;
  readonly toolchain: LatexToolchainInfo | undefined;
  readonly stale: boolean;
  readonly hasPdf: boolean;
  readonly enabled: boolean;
  readonly activePath: string | undefined;
  readonly content: string;
  readonly cursorOffset: number;
  readonly gateway: WritingGateway;
  readonly onSource: (location: SynctexSourceLocation, isCurrent: () => boolean) => Promise<void>;
  readonly onPdf: () => void;
  readonly onError: (message: string) => void;
}

export function useWritingSynctex(options: Options) {
  const scope = `${options.manuscriptId ?? ""}:${options.run?.id ?? ""}:${options.stale}:${options.enabled}:${options.displayedPdfRevision ?? ""}`;
  const latest = useRef({ scope, epoch: 0 });
  if (latest.current.scope !== scope) latest.current = { scope, epoch: latest.current.epoch + 1 };
  const busyRef = useRef<number | undefined>(undefined);
  const [busy, setBusy] = useState<number>();
  const [point, setPoint] = useState<{ scope: string; value: PdfReadingPosition }>();
  const [location, setLocation] = useState<{ scope: string; value: SynctexPdfLocation & { token: number } }>();
  const token = useRef(0);
  useEffect(() => () => { latest.current.epoch += 1; }, []);
  const commonDisabled = !options.enabled || !options.hasPdf || !options.run ? "请先成功编译稿件"  : options.displayedPdfRevision !== options.run.id ? "请等待当前 PDF 加载完成" : options.stale ? "源码已修改，请重新编译后定位" : !options.run.artifacts.some((item) => item.kind === "synctex") || !options.toolchain?.tools.some((item) => item.name === "synctex" && item.available) ? "当前编译结果没有可用的 SyncTeX" : busy === latest.current.epoch ? "正在定位…" : undefined;
  const forwardDisabled = commonDisabled ?? (!options.activePath ? "请先打开源码文件" : undefined);
  const backwardDisabled = commonDisabled ?? (point?.scope !== scope ? "请先查看 PDF 页面" : undefined);
  const onReadingPosition = useCallback((value: PdfReadingPosition) => { if (value.key === options.manuscriptId && value.revision === options.run?.id) setPoint({ scope, value }); }, [scope, options.manuscriptId, options.run?.id]);

  async function request(direction: "forward" | "backward", explicitPoint?: PdfReadingPosition): Promise<void> {
    if (commonDisabled || (direction === "forward" && forwardDisabled) || (direction === "backward" && !explicitPoint && backwardDisabled)) return;
    const run = options.run;
    if (!run) return;
    const epoch = latest.current.epoch;
    if (busyRef.current === epoch) return;
    busyRef.current = epoch; setBusy(epoch);
    const isCurrent = (): boolean => latest.current.epoch === epoch;
    try {
      if (direction === "forward" && options.activePath) {
        const before = options.content.slice(0, options.cursorOffset);
        const matches = await options.gateway.forwardSynctex(run.id, options.activePath, before.split("\n").length, options.cursorOffset - (before.lastIndexOf("\n") + 1));
        if (!isCurrent()) return;
        const match = matches[0];
        if (!match) { options.onError("没有找到此源码位置对应的 PDF 内容"); return; }
        setLocation({ scope, value: { ...match, token: ++token.current } }); options.onPdf();
      } else {
        const reading = explicitPoint ?? point?.value;
        if (!reading) return;
        const matches = await options.gateway.inverseSynctex(run.id, reading.page, reading.x, reading.y);
        if (!isCurrent()) return;
        const match = matches[0];
        if (!match) { options.onError("没有找到此 PDF 位置对应的源码"); return; }
        await options.onSource(match, isCurrent);
      }
    } catch (reason: unknown) { if (isCurrent()) options.onError(errorMessage(reason)); }
    finally { if (busyRef.current === epoch) { busyRef.current = undefined; setBusy(undefined); } }
  }
  return {
    location: location?.scope === scope ? location.value : undefined,
    onReadingPosition,
    inverse: (page: number, x: number, y: number) => {
      if (commonDisabled) { options.onError(commonDisabled); return; }
      void request("backward", { page, x, y, key: options.manuscriptId ?? "", revision: options.run?.id ?? "" });
    },
    actions: { forward: () => void request("forward"), backward: () => void request("backward"), forwardDisabled, backwardDisabled },
  };
}
