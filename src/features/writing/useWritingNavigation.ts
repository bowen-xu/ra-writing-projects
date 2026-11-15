import { useRef, type Dispatch, type SetStateAction } from "react";
import type { SaveState } from "./workspaceState";
import type { WritingTabMode } from "./tabs/WritingProjectTabs";

interface Options {
  readonly activePath: string | undefined;
  readonly activeManuscriptId: string | undefined;
  readonly openPaths: readonly string[];
  readonly saveState: SaveState;
  readonly canNavigate: () => boolean;
  readonly saveCurrent: () => Promise<boolean>;
  readonly openFile: (path: string) => Promise<unknown>;
  readonly prepareTabOpen?: (project: string, path: string, mode: WritingTabMode) => (() => void) | undefined;
  readonly setActivePath: Dispatch<SetStateAction<string | undefined>>;
  readonly setActiveManuscriptId: Dispatch<SetStateAction<string | undefined>>;
  readonly setOpenPaths: Dispatch<SetStateAction<readonly string[]>>;
  readonly setContent: Dispatch<SetStateAction<string>>;
  readonly setContentHash: Dispatch<SetStateAction<string | undefined>>;
  readonly setIsLibraryOpen: Dispatch<SetStateAction<boolean>>;
  readonly setFocusRequest: (value: {readonly path: string; readonly line: number; readonly token: number}) => void;
}

export function useWritingNavigation(options: Options) {
  const current = useRef(options);
  const sequence = useRef(0);
  current.current = options;
  const owns = (host: Options) => current.current.canNavigate()
    && current.current.activeManuscriptId === host.activeManuscriptId && current.current.activePath === host.activePath;
  async function selectFile(path: string, mode: WritingTabMode = "pinned"): Promise<boolean> {
    const request = ++sequence.current;
    const host = current.current;
    if (!owns(host)) return false;
    const complete = host.activeManuscriptId ? host.prepareTabOpen?.(host.activeManuscriptId, path, mode) : undefined;
    if (path === host.activePath) { complete?.(); return true; }
    if (!(await host.saveCurrent()) || !owns(host) || request !== sequence.current) return false;
    const opened = await host.openFile(path);
    if (opened === undefined || request !== sequence.current || current.current.activeManuscriptId !== host.activeManuscriptId || !current.current.canNavigate()) return false;
    complete?.(); return true;
  }
  async function closeFile(path: string): Promise<void> {
    sequence.current += 1;
    const host = current.current;
    if (!owns(host)) return;
    if (path === host.activePath) {
      if ((host.saveState === "dirty" || host.saveState === "error")
        && !window.confirm("该文件有未保存内容。保存后关闭标签？")) return;
      if (!(await host.saveCurrent()) || !owns(host)) return;
    }
    const nextPaths = host.openPaths.filter(value => value !== path);
    host.setOpenPaths(nextPaths);
    if (path !== host.activePath) return;
    const next = nextPaths.at(-1);
    if (next !== undefined) await host.openFile(next);
    else { host.setActivePath(undefined); host.setContent(""); host.setContentHash(undefined); }
  }
  async function selectManuscript(id: string): Promise<boolean> {
    sequence.current += 1;
    const host = current.current;
    if (!owns(host)) return false;
    if (id !== host.activeManuscriptId) {
      if (!(await host.saveCurrent()) || !owns(host)) return false;
      host.setActiveManuscriptId(id);
    }
    host.setIsLibraryOpen(false);
    return true;
  }
  async function openDiagnostic(path: string, line: number): Promise<void> {
    const manuscriptId = current.current.activeManuscriptId;
    if (!(await selectFile(path)) || !current.current.canNavigate()
      || current.current.activeManuscriptId !== manuscriptId) return;
    current.current.setFocusRequest({path, line, token: Date.now()});
  }
  return {selectFile, closeFile, selectManuscript, openDiagnostic};
}
