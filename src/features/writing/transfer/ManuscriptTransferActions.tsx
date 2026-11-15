import { WritingMenuItem } from "../WritingMenu";
import type { Manuscript, ManuscriptImportPreview } from "@research-assistant/writing";
import { open } from "@research-assistant/workbench-sdk/platform";
import { useRef, useState } from "react";

import type { WritingGateway } from "../gateway";
import { ManuscriptImportDialog } from "./ManuscriptImportDialog";
import { ManuscriptResourceImportDialog } from "./ManuscriptResourceImportDialog";
import { downloadManuscript } from "./downloadManuscript";
import { notify } from "@research-assistant/workbench-sdk/feedback";

interface PendingImport {
  readonly initialTitle: string;
  readonly preview: ManuscriptImportPreview;
  readonly sourceLabel: string;
  readonly sourcePath: string;
}

interface PendingResources {
  readonly manuscriptId: string;
  readonly sourcePaths: string[];
}

interface ManuscriptTransferActionsProps {
  readonly importOnly?: boolean;
  readonly variant?: "all" | "imports" | "exports";
  readonly beforeExport?: () => Promise<boolean>;
  readonly activeManuscript: Manuscript | undefined;
  readonly gateway: WritingGateway;
  readonly hasPdf: boolean;
  readonly onError: (message: string) => void;
  readonly onImported: (manuscript: Manuscript) => void;
  readonly onResourcesImported: () => void;
}

export function ManuscriptTransferActions(props: ManuscriptTransferActionsProps): React.JSX.Element {
  const [isTransferring, setIsTransferring] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pendingImport, setPendingImport] = useState<PendingImport>();
  const [pendingResources, setPendingResources] = useState<PendingResources>();
  const exporting = useRef(false);

  async function importProject(kind: "directory" | "zip"): Promise<void> {
    if (!props.gateway.supportsCompilation) return;
    const selected = kind === "directory"
      ? await open({ directory: true, multiple: false })
      : await open({ multiple: false, filters: [{ name: "LaTeX ZIP", extensions: ["zip"] }] });
    if (selected === null) return;
    const sourceLabel = selected.split(/[\\/]/u).at(-1) ?? "LaTeX 工程";
    const initialTitle = sourceLabel.replace(/\.zip$/iu, "") || "Imported manuscript";
    setIsTransferring(true);
    setMessage("正在安全检查工程…");
    try {
      const preview = await props.gateway.previewImport(selected);
      setPendingImport({ initialTitle, preview, sourceLabel, sourcePath: selected });
      setMessage(undefined);
    } catch (reason: unknown) {
      props.onError(errorMessage(reason));
      setMessage(undefined);
    } finally {
      setIsTransferring(false);
    }
  }

  async function confirmImport(title: string, rootPath: string): Promise<boolean> {
    if (pendingImport === undefined) return false;
    setIsTransferring(true);
    setMessage("正在安全复制工程…");
    try {
      const result = await props.gateway.importProject(
        title,
        pendingImport.sourcePath,
        rootPath,
      );
      props.onImported(result.manuscript);
      setMessage(`已导入 ${result.fileCount} 个文件，根文档：${result.manuscript.rootPath}`);
      return true;
    } catch (reason: unknown) {
      props.onError(errorMessage(reason));
      setMessage(undefined);
      return false;
    } finally {
      setIsTransferring(false);
    }
  }

  async function exportProject(kind: "source" | "pdf"): Promise<void> {
    if (props.activeManuscript === undefined || !props.gateway.supportsCompilation || exporting.current) return;
    exporting.current = true;
    setIsTransferring(true);
    const label = kind === "source" ? "源码 ZIP" : "PDF";
    const notification = notify.loading(`正在下载${label}…`);
    try {
      if (props.beforeExport && !(await props.beforeExport())) {
        notify.error("下载未完成：请先保存稿件", { id: notification });
        return;
      }
      const result = await downloadManuscript(props.gateway, props.activeManuscript, kind);
      notify.success(`${label}已保存到 Downloads（下载）文件夹`, {
        id: notification,
        description: `${result.destinationPath}（${formatBytes(result.byteSize)}）`,
        duration: 10_000,
      });
    } catch (reason: unknown) {
      notify.error(`${label}下载失败`, { id: notification, description: errorMessage(reason) });
    } finally {
      exporting.current = false;
      setIsTransferring(false);
    }
  }

  async function importResources(): Promise<void> {
    if (props.activeManuscript === undefined || !props.gateway.supportsCompilation) return;
    try {
      const selected = await open({ multiple: true, directory: false });
      if (selected === null) return;
      setPendingResources({
        manuscriptId: props.activeManuscript.id,
        sourcePaths: Array.isArray(selected) ? selected : [selected],
      });
    } catch (reason: unknown) {
      props.onError(errorMessage(reason));
    }
  }

  async function confirmResources(destinationDirectory: string): Promise<void> {
    if (pendingResources === undefined) return;
    const {manuscriptId, sourcePaths} = pendingResources;
    setPendingResources(undefined);
    setIsTransferring(true);
    setMessage("正在复制资源文件…");
    try {
      const result = await props.gateway.importResources(
        manuscriptId,
        destinationDirectory,
        sourcePaths,
      );
      props.onResourcesImported();
      setMessage(`已导入 ${result.importedPaths.length} 个资源（${formatBytes(result.byteSize)}）`);
    } catch (reason: unknown) {
      props.onError(errorMessage(reason));
      setMessage(undefined);
    } finally {
      setIsTransferring(false);
    }
  }

  return (
    <>
      {props.variant !== "exports" && <>
      <WritingMenuItem className="transfer-button" disabled={isTransferring || !props.gateway.supportsCompilation} onClick={() => void importProject("directory")} type="button">导入目录</WritingMenuItem>
      <WritingMenuItem className="transfer-button" disabled={isTransferring || !props.gateway.supportsCompilation} onClick={() => void importProject("zip")} type="button">导入 ZIP</WritingMenuItem>
      </>}
      {!props.importOnly && <>
      {props.variant !== "exports" && <WritingMenuItem className="transfer-button" disabled={props.activeManuscript === undefined || isTransferring || !props.gateway.supportsCompilation} onClick={() => void importResources()} type="button">上传资源</WritingMenuItem>}
      {props.variant !== "imports" && <>
      <WritingMenuItem className="transfer-button" disabled={!props.hasPdf || isTransferring || !props.gateway.supportsCompilation} onClick={() => void exportProject("pdf")} role={props.variant === "exports" ? "menuitem" : undefined} type="button">下载 PDF</WritingMenuItem>
      <WritingMenuItem className="transfer-button" disabled={props.activeManuscript === undefined || isTransferring || !props.gateway.supportsCompilation} onClick={() => void exportProject("source")} role={props.variant === "exports" ? "menuitem" : undefined} type="button">下载源码（.zip）</WritingMenuItem>
      </>}
      </>}
      {message !== undefined && <div className="transfer-status" role="status">{message}<button aria-label="关闭导入导出状态" onClick={() => setMessage(undefined)} type="button">×</button></div>}
      {pendingImport !== undefined && (
        <ManuscriptImportDialog
          initialTitle={pendingImport.initialTitle}
          onCancel={() => setPendingImport(undefined)}
          onConfirm={confirmImport}
          preview={pendingImport.preview}
          sourceLabel={pendingImport.sourceLabel}
        />
      )}
      {pendingResources !== undefined && (
        <ManuscriptResourceImportDialog
          onCancel={() => setPendingResources(undefined)}
          onConfirm={directory => void confirmResources(directory)}
        />
      )}
    </>
  );
}

function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function errorMessage(reason: unknown): string {
  if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string") return reason.message;
  return reason instanceof Error ? reason.message : String(reason);
}
