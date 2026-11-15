import { openNoteDocumentTab } from "@research-assistant/workbench-sdk/note-documents";
import { useRef, useState } from "react";
import { isWritingNotePath, type ManuscriptFile } from "@research-assistant/writing";
import type { WritingGateway } from "../gateway";
import { WritingNoteFloatingPanel, type WritingNoteWindowPort, type WritingNoteWindowTarget } from "./WritingNoteFloatingPanel";
import { notify } from "@research-assistant/workbench-sdk/feedback";

export function useWritingNoteWindows(options: {
  readonly gateway: WritingGateway; readonly manuscriptId: string | undefined; readonly activePath: string | undefined;
  readonly rootPath: string | undefined; readonly openPaths: readonly string[];
  readonly selectFile: (path: string, mode?: "preview" | "pinned") => Promise<boolean>;
  readonly closeFile: (path: string) => Promise<void>;
  readonly setFiles: (files: readonly ManuscriptFile[]) => void;
}) {
  const [target, setTarget] = useState<WritingNoteWindowTarget>();
  const port = useRef<WritingNoteWindowPort>(null), busy = useRef(false), sourcePaths = useRef(new Map<string, string>());
  const latest = useRef(options); latest.current = options;
  if (options.manuscriptId && options.activePath && !isWritingNotePath(options.activePath)) sourcePaths.current.set(options.manuscriptId, options.activePath);
  async function prepare(path?: string): Promise<boolean> {
    if (!target || path && target.manuscriptId !== options.manuscriptId || path && target.path !== path && !target.path.startsWith(`${path}/`)) return true;
    if (port.current && !await port.current.prepareClose()) return false;
    setTarget(undefined); return true;
  }
  async function open(path: string): Promise<boolean> {
    if (!isWritingNotePath(path)) return options.selectFile(path, "preview");
    if (!options.manuscriptId || busy.current) return false;
    if (target?.manuscriptId === options.manuscriptId && target.path === path) return true;
    busy.current = true;
    try {
      if (!await prepare()) return false;
      const source = sourcePaths.current.get(options.manuscriptId) ?? options.rootPath;
      if (options.activePath === path && source && !await options.selectFile(source, "preview")) return false;
      // Transfer any retained file session before mounting the auxiliary host.
      if (options.openPaths.includes(path)) await options.closeFile(path);
      if (latest.current.manuscriptId !== options.manuscriptId) return false;
      setTarget({ manuscriptId: options.manuscriptId, path, token: crypto.randomUUID() }); return true;
    } catch (reason) { notify.error(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { busy.current = false; }
  }
  async function pin(path: string): Promise<boolean> {
    if (!await prepare(path)) return false;
    return latest.current.selectFile(path, "pinned");
  }
  return { open, pin, prepare, activePath: target && target.manuscriptId === options.manuscriptId ? target.path : undefined,
    surface: target ? <WritingNoteFloatingPanel key={target.token} target={target} gateway={options.gateway} windowRef={port} onClose={() => setTarget(undefined)}
      onFilesChanged={(id, files) => { if (latest.current.manuscriptId === id) latest.current.setFiles(files); }}
      onExpand={async item => {
        await openNoteDocumentTab({ kind: "writing", manuscriptId: item.manuscriptId, path: item.path });
        return true;
      }} /> : null };
}
