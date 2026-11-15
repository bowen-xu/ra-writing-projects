import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { WritingMenuItem } from "../WritingMenu";
import type { PdfDocumentIdentity, PdfSource } from "@research-assistant/core/pdf-view";
import type { AgentCompileResult } from "@research-assistant/core/agent";
import type { CompileRun, LatexToolchainInfo, SynctexPdfLocation } from "@research-assistant/writing";
import { useEffect, useRef, useState } from "react";
import { FileText, ScrollText } from "lucide-react";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { agentCompileRemainingMs } from "./agentCompileLifecycle";

import { WritingSyncButton, type WritingSyncActions } from "../WritingDivider";
import type { PdfReadingPosition } from "./writingPdfCoordinates";
import { PreviewMenu } from "./PreviewMenu";
import { ManuscriptPdfPreview } from "./ManuscriptPdfPreview";
import { CompileOptionsMenu } from "./CompileOptionsMenu";
import type { CompilePreferences } from "../compilePreferences";
import { createAgentCompileRequestGate } from "./agentCompileRequestGate";

type PreviewTab = "pdf" | "problems" | "log";

interface CompilePanelProps {
  readonly compilePreferences: CompilePreferences;
  readonly onCompilePreferencesChange: (preferences: CompilePreferences) => void;
  readonly onCompileFromScratch: () => void;
  readonly isCompiling: boolean;
  readonly toolchain: LatexToolchainInfo | undefined;
  readonly run: CompileRun | undefined;
  readonly active: boolean;
  readonly pdfIdentity: PdfDocumentIdentity | undefined;
  readonly onDisplayedVersion: (revision: string | undefined) => void;
  readonly pdfBytes: Uint8Array | undefined;
  readonly onCompile: () => void;
  readonly onCancel: () => void;
  readonly autoCompile: boolean;
  readonly onAutoCompileChange: (value: boolean) => void;
  readonly isPdfStale: boolean;
  readonly syncActions: WritingSyncActions;
  readonly onReadingPosition: (position: PdfReadingPosition) => void;
  readonly onOpenDiagnostic: (file: string, line: number) => void;
  readonly synctexLocation: (SynctexPdfLocation & { readonly token: number }) | undefined;
  readonly onInverseSearch: (page: number, x: number, y: number) => void;
  readonly agentCompileResult?: AgentCompileResult;
  readonly loadAgentPdf?: (result: AgentCompileResult) => Promise<PdfSource>;
  readonly onAgentInverseSearch?: (result: AgentCompileResult, page: number, x: number, y: number) => Promise<void> | void;
  readonly onAgentForwardSearch?: (result: AgentCompileResult) => Promise<(SynctexPdfLocation & { readonly token: number }) | undefined>;
  readonly onAgentLocationChange?: (location: (SynctexPdfLocation & { readonly token: number }) | undefined) => void;
  readonly agentSynctexLocation?: (SynctexPdfLocation & { readonly token: number }) | undefined;
  readonly onAgentPdfReadingPosition?: (position: PdfReadingPosition | undefined) => void;
  readonly onAgentPdfVisibilityChange?: (visible: boolean) => void;
  readonly agentSyncBusy?: boolean;
  readonly onAgentSyncBusyChange?: (busy: boolean) => void;
}

export function CompilePanel(props: CompilePanelProps): React.JSX.Element {
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<PreviewTab>("pdf");
  const [agentSource, setAgentSource] = useState<PdfSource>();
  const [agentExpired, setAgentExpired] = useState(false);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentReadingPosition, setAgentReadingPosition] = useState<PdfReadingPosition>();
  const [agentLocation, setAgentLocation] = useState<(SynctexPdfLocation & { readonly token: number })>();
  const agentRequestGate = useRef<ReturnType<typeof createAgentCompileRequestGate> | undefined>(undefined);
  if (!agentRequestGate.current) agentRequestGate.current = createAgentCompileRequestGate();
  const requestGate = agentRequestGate.current;
  const formalSource = props.pdfBytes !== undefined && props.pdfIdentity !== undefined ? { ...props.pdfIdentity, bytes: props.pdfBytes } : undefined;
  const source = agentSource ?? formalSource;
  useEffect(() => {
    requestGate.invalidate();
    setAgentSource(undefined);
    setAgentExpired(false);
  }, [props.agentCompileResult?.resultId, props.pdfIdentity?.revision]);
  useEffect(() => {
    requestGate.invalidate();
    setAgentLocation(undefined);
    props.onAgentLocationChange?.(undefined);
    setAgentReadingPosition(undefined);
    props.onAgentPdfReadingPosition?.(undefined);
  }, [props.agentCompileResult?.resultId]);
  useEffect(() => {
    props.onAgentPdfVisibilityChange?.(agentSource !== undefined);
    if (!agentSource) props.onAgentPdfReadingPosition?.(undefined);
  }, [agentSource]);
  useEffect(() => {
    if (!props.agentCompileResult) return;
    const expire = (): void => {
      const wasVisible = agentSource !== undefined || agentLoading;
      requestGate.invalidate();
      setAgentLoading(false);
      setAgentSource(undefined);
      setAgentLocation(undefined);
      setAgentReadingPosition(undefined);
      setAgentExpired(true);
      props.onAgentLocationChange?.(undefined);
      props.onAgentPdfReadingPosition?.(undefined);
      props.onAgentSyncBusyChange?.(false);
      if (wasVisible) notify.info("Agent 临时 PDF 已过期，请重新编译后再打开。");
    };
    const remainingMs = agentCompileRemainingMs(props.agentCompileResult);
    if (remainingMs === 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, remainingMs);
    return () => window.clearTimeout(timer);
  }, [agentLoading, agentSource, props.agentCompileResult, requestGate]);
  useEffect(() => { if (props.synctexLocation) setTab("pdf"); }, [props.synctexLocation]);
  const isRunning = props.isCompiling;
  const agentSyncBusy = props.agentSyncBusy ?? false;
  const handleReadingPosition = (position: PdfReadingPosition): void => {
    if (agentSource && props.agentCompileResult && position.revision === props.agentCompileResult.resultId) {
      setAgentReadingPosition(position);
      props.onAgentPdfReadingPosition?.(position);
    }
    props.onReadingPosition(position);
  };
  const agentSyncActions: WritingSyncActions | undefined = agentSource && props.agentCompileResult && props.onAgentForwardSearch && props.onAgentInverseSearch
    ? {
      forward: () => {
        if (agentSyncBusy || props.isPdfStale) return;
        props.onAgentSyncBusyChange?.(true);
        const result = props.agentCompileResult as AgentCompileResult;
        const requestEpoch = requestGate.begin();
        const resultId = result.resultId;
        void props.onAgentForwardSearch?.(result).then((nextLocation) => {
          if (!requestGate.isCurrent(requestEpoch) || resultId !== props.agentCompileResult?.resultId) return;
          setAgentLocation(nextLocation);
          props.onAgentLocationChange?.(nextLocation);
        }).catch(() => undefined).finally(() => {
          if (requestGate.isCurrent(requestEpoch)) props.onAgentSyncBusyChange?.(false);
        });
      },
      backward: () => {
        if (agentSyncBusy || props.isPdfStale || !agentReadingPosition) return;
        props.onAgentSyncBusyChange?.(true);
        const result = props.agentCompileResult as AgentCompileResult;
        void Promise.resolve(props.onAgentInverseSearch?.(result, agentReadingPosition.page, agentReadingPosition.x, agentReadingPosition.y))
          .finally(() => props.onAgentSyncBusyChange?.(false));
      },
      forwardDisabled: props.isPdfStale ? "源码已修改，请重新编译后定位" : agentSyncBusy ? "正在定位…" : undefined,
      backwardDisabled: props.isPdfStale ? "源码已修改，请重新编译后定位" : !agentReadingPosition ? "请先查看 Agent PDF 页面" : agentSyncBusy ? "正在定位…" : undefined,
    }
    : undefined;
  const visibleSyncActions = agentSyncActions ?? props.syncActions;
  const locationRequest = agentSource ? (props.agentSynctexLocation ?? agentLocation) : props.synctexLocation;

  return (
    <>
      <div className="writing-preview-toolbar" aria-label="PDF 与编译工具">
        <div className="writing-compile-split">
          <ControlHint content="保存并编译：Cmd/Ctrl+S 或 Cmd/Ctrl+Enter"><button className="writing-primary" disabled={!isRunning && !props.toolchain?.available} onClick={isRunning ? props.onCancel : props.onCompile} type="button">{isRunning ? "停止编译" : props.pdfBytes ? "重新编译" : "编译 PDF"}</button></ControlHint>
          <CompileOptionsMenu autoCompile={props.autoCompile} onAutoCompileChange={props.onAutoCompileChange} preferences={props.compilePreferences} onPreferencesChange={props.onCompilePreferencesChange} available={props.toolchain?.available === true} isCompiling={isRunning} onCancel={props.onCancel} onFromScratch={props.onCompileFromScratch} />
        </div>
        <PreviewMenu label={`问题与日志（${props.run?.diagnostics.length ?? 0}）`} trigger={<><ScrollText size={17} />{!!props.run?.diagnostics.length && <span className="compile-problem-count">{props.run.diagnostics.length}</span>}</>}>
          <WritingMenuItem aria-pressed={tab === "pdf"} onClick={() => setTab("pdf")}>PDF 预览</WritingMenuItem>
          <WritingMenuItem aria-pressed={tab === "problems"} onClick={() => setTab("problems")}>问题 {props.run?.diagnostics.length ?? 0}</WritingMenuItem>
          <WritingMenuItem aria-pressed={tab === "log"} onClick={() => setTab("log")}>编译日志</WritingMenuItem>
        </PreviewMenu>
        {props.run?.status === "failed" && (
          <ControlHint content="编译存在错误，请查看问题与日志；PDF 内容可能不完整"><button type="button" onClick={() => setTab("problems")}>
            {props.run.artifacts.some((artifact) => artifact.kind === "pdf") ? "PDF 已生成 · 有错误" : "编译失败"}
          </button></ControlHint>
        )}
        {props.isPdfStale && props.pdfBytes && <ControlHint content="源码已修改，请重新编译"><span className="writing-preview-stale" role="status">待编译</span></ControlHint>}
        {props.agentCompileResult?.status === "succeeded" && !agentExpired && props.loadAgentPdf && (
          <ControlHint content="打开批准副本的临时 PDF 预览"><button type="button" disabled={agentLoading} onClick={() => {
            const requestEpoch = requestGate.begin();
            const resultId = props.agentCompileResult?.resultId;
            const result = props.agentCompileResult as AgentCompileResult;
            setAgentLoading(true);
            void props.loadAgentPdf?.(result).then((nextSource) => {
              if (requestGate.isCurrent(requestEpoch) && resultId === props.agentCompileResult?.resultId) { setAgentExpired(false); setAgentSource(nextSource); }
            }).catch((reason: unknown) => {
              if (requestGate.isCurrent(requestEpoch)) notify.error(String(reason));
            }).finally(() => {
              if (requestGate.isCurrent(requestEpoch)) setAgentLoading(false);
            });
          }}>{agentLoading ? "正在打开…" : "Agent PDF"}</button></ControlHint>
        )}
        {agentSource && agentSyncActions && <ControlHint content={agentSyncActions.forwardDisabled ?? "源码定位到 Agent PDF"}><button type="button" disabled={agentSyncActions.forwardDisabled !== undefined} onClick={agentSyncActions.forward}>源码→PDF</button></ControlHint>}
        <WritingSyncButton direction="backward" actions={visibleSyncActions} className="writing-narrow-sync" />
        <div className="writing-pdf-controls-slot" ref={setToolbarTarget} />
      </div>
      {source !== undefined && (
        <div className="writing-pdf-host" hidden={tab !== "pdf"}>
        <ManuscriptPdfPreview
          toolbarTarget={toolbarTarget}
          onShowPdf={() => setTab("pdf")}
          onReadingPosition={handleReadingPosition}
          source={source}
          active={props.active && tab === "pdf"}
          onDisplayedVersion={props.onDisplayedVersion}
          {...(locationRequest === undefined ? {} : { locationRequest })}
          onInverseSearch={agentSource && props.agentCompileResult && props.onAgentInverseSearch ? (page, x, y) => props.onAgentInverseSearch?.(props.agentCompileResult as AgentCompileResult, page, x, y) : props.onInverseSearch}
        />
        </div>
      )}
      {tab === "pdf" && props.pdfBytes === undefined && (
        <section className="compile-placeholder">
          <FileText size={42} strokeWidth={1.2} aria-hidden="true" />
          <h3>{emptyTitle(props.toolchain, isRunning)}</h3>
          <p>{emptyMessage(props.toolchain, isRunning)}</p>
          {isRunning
            ? <button className="cancel-compile-button" onClick={props.onCancel} type="button">取消编译</button>
            : <button className="primary-button" disabled={!props.toolchain?.available} onClick={props.onCompile} type="button">开始编译</button>}
        </section>
      )}
      {tab === "problems" && (
        <div className="diagnostics-panel">
          {props.run?.diagnostics.length
            ? props.run.diagnostics.map((diagnostic, index) => (
              <button
                className={`diagnostic-row ${diagnostic.severity}`}
                disabled={diagnostic.file === undefined || diagnostic.line === undefined}
                key={`${diagnostic.message}-${index}`}
                onClick={() => diagnostic.file !== undefined && diagnostic.line !== undefined && props.onOpenDiagnostic(diagnostic.file, diagnostic.line)}
                type="button"
              >
                <span>{diagnostic.severity === "error" ? "错误" : diagnostic.severity === "warning" ? "警告" : "信息"}</span>
                <strong>{diagnostic.message}</strong>
                <small>{diagnostic.file === undefined ? "全局" : `${diagnostic.file}:${diagnostic.line ?? ""}`}</small>
              </button>
            ))
            : <div className="panel-empty">当前没有结构化问题</div>}
        </div>
      )}
      {tab === "log" && <pre className="build-log">{props.run?.rawOutput || "尚无编译日志"}</pre>}
    </>
  );
}

function emptyTitle(toolchain: LatexToolchainInfo | undefined, isRunning: boolean): string {
  if (isRunning) return "正在编译";
  if (toolchain === undefined) return "正在检测 LaTeX 环境";
  return toolchain.available ? "等待第一次编译" : "LaTeX 环境不可用";
}

function emptyMessage(toolchain: LatexToolchainInfo | undefined, isRunning: boolean): string {
  if (isRunning) return "latexmk 正在隔离的工程快照中运行，可随时取消。";
  if (toolchain?.available) return "编译会先保存源码，再使用本机 latexmk 生成 PDF、诊断与 SyncTeX。";
  return "请先安装包含 latexmk 的 TeX Live、MacTeX 或 MiKTeX；应用不会自动下载或修改系统工具链。";
}
