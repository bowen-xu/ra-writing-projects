import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { isWritingNotePath, writingNoteTitle, type Manuscript } from "@research-assistant/writing";
import { usePublishWorkspaceTabs } from "@research-assistant/workbench-sdk/workbench";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { WritingFileSaveQueue } from "../persistence/WritingFileSaveQueue";
import type { SaveState } from "../workspaceState";
import { WritingProjectTabs, type WritingTabMode } from "./WritingProjectTabs";
import {writeWorkspaceState} from "@research-assistant/workbench-sdk/workspace-state";

interface Options {
  readonly catalogReady?: boolean;
  readonly store: WritingProjectTabs;
  readonly manuscripts: readonly Manuscript[];
  readonly manuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly openPaths: readonly string[];
  readonly cursorState: Readonly<Record<string, number>>;
  readonly layoutState: Readonly<Record<string, unknown>>;
  readonly ready: boolean;
  readonly active: boolean;
  readonly home: boolean;
  readonly saveState: SaveState;
  readonly files: WritingFileSessions;
  readonly saves: WritingFileSaveQueue;
  readonly canNavigate: () => boolean;
  readonly selectProject: (id: string) => Promise<boolean>;
  readonly selectFile: (path: string, mode?: WritingTabMode) => Promise<boolean>;
  readonly closeFile: (path: string) => Promise<void>;
  readonly setOpenPaths: Dispatch<SetStateAction<readonly string[]>>;
  readonly onHome: () => void;
  readonly showEditor: () => void;
}

export function useWritingWorkspaceTabs(options: Options) {
  const { store } = options;
  const projects = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const revision = useSyncExternalStore(options.files.subscribe, options.files.getRevision);
  const current = useRef(options); current.current = options;
  const [pending, setPending] = useState<{ project: string; path: string }>();
  const navigation = useRef(0);
  const observedProject = useRef(options.manuscriptId);
  useEffect(() => {
    const previous = observedProject.current; observedProject.current = options.manuscriptId;
    if (pending && previous !== options.manuscriptId && options.manuscriptId !== pending.project) {
      navigation.current += 1; setPending(undefined);
    }
  }, [pending, options.manuscriptId]);
  useEffect(() => {
    if (options.ready && options.manuscriptId) store.sync({ manuscriptId: options.manuscriptId, openPaths: options.openPaths,
      activePath: options.activePath, cursorState: options.cursorState, layoutState: options.layoutState });
  }, [store, options.ready, options.manuscriptId, options.openPaths, options.activePath, options.cursorState, options.layoutState]);
  useEffect(() => { if (options.catalogReady !== false) store.retainProjects(options.manuscripts.map(project => project.id)); }, [store, options.manuscripts, options.catalogReady]);
  useEffect(() => { if (options.catalogReady !== false) writeWorkspaceState("writing-projects",projects); }, [projects,options.catalogReady]);
  useEffect(() => {
    for (const project of store.getSnapshot()) {
      const path = project.previewPath;
      if (path && (options.files.get({ manuscriptId: project.manuscriptId, relativePath: path })?.pending
        || project.manuscriptId === options.manuscriptId && path === options.activePath && options.saveState !== "saved")) store.pin(project.manuscriptId, path);
    }
  }, [store, revision, projects, options.files, options.manuscriptId, options.activePath, options.saveState]);
  async function select(project: string, path: string): Promise<void> {
    const sequence = ++navigation.current;
    setPending(undefined);
    if (!current.current.canNavigate()) return;
    if (current.current.manuscriptId === project && current.current.ready) {
      if (await current.current.selectFile(path, "preview") && sequence === navigation.current) current.current.showEditor();
      return;
    }
    if (await current.current.selectProject(project) && sequence === navigation.current) setPending({ project, path });
  }
  useEffect(() => {
    if (!pending || !options.ready || options.manuscriptId !== pending.project) return;
    const sequence = navigation.current;
    setPending(undefined);
    void options.selectFile(pending.path, "preview").then(opened => {
      if (opened && sequence === navigation.current) current.current.showEditor();
    }).catch(reason => notify.error(String(reason)));
  }, [pending, options.ready, options.manuscriptId, options.selectFile]);
  async function close(project: string, path: string): Promise<void> {
    if (!current.current.canNavigate()) return;
    if (project === current.current.manuscriptId) { await current.current.closeFile(path); return; }
    const session = current.current.files.get({ manuscriptId: project, relativePath: path });
    if (session) await current.current.saves.save(session.identity);
    if (!current.current.canNavigate()) return;
    if (project === current.current.manuscriptId) { await current.current.closeFile(path); return; }
    store.close(project, path);
  }
  const managed = usePublishWorkspaceTabs("writing", [
    { id: "writing:home", owner: "writing", title: "返回写作项目列表", home: true, active: options.active && options.home,
      select: () => { navigation.current += 1; setPending(undefined); current.current.onHome(); } },
    ...projects.flatMap(project => project.openPaths.map(path => {
      const name = isWritingNotePath(path) ? writingNoteTitle(path) : path.split("/").at(-1) ?? path;
      const title = options.manuscripts.find(manuscript => manuscript.id === project.manuscriptId)?.title ?? project.manuscriptId;
      return { id: `writing:${project.manuscriptId}:${path}`, owner: "writing" as const,
        title: projects.filter(candidate => candidate.openPaths.length).length > 1 ? `${name} · ${title}` : name,
        presentation: isWritingNotePath(path) ? "document" as const : "workspace" as const,
        icon: isWritingNotePath(path) ? "text" as const : "code" as const,
        active: options.active && !options.home && project.manuscriptId === options.manuscriptId && path === options.activePath,
        preview: project.previewPath === path, dirty: project.manuscriptId === options.manuscriptId && path === options.activePath && options.saveState === "dirty",
        pending: options.files.get({ manuscriptId: project.manuscriptId, relativePath: path })?.pending ?? false,
        select: () => { void select(project.manuscriptId, path).catch(reason => notify.error(String(reason))); },
        close: () => { void close(project.manuscriptId, path).catch(reason => notify.error(String(reason))); },
        pin: () => store.pin(project.manuscriptId, path),
      };
    })),
  ]);
  function prepareOpen(project: string, path: string, mode: WritingTabMode): () => void {
    const preview = store.get(project)?.previewPath;
    if (preview && (current.current.files.get({ manuscriptId: project, relativePath: preview })?.pending
      || current.current.activePath === preview && current.current.manuscriptId === project && current.current.saveState !== "saved")) store.pin(project, preview);
    const complete = store.prepareOpen(project, path, mode);
    return () => { const paths = complete(); if (current.current.manuscriptId === project) current.current.setOpenPaths(paths); };
  }
  return { projects, prepareOpen, managed };
}
