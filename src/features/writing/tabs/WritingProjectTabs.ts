export type WritingTabMode = "preview" | "pinned";
export interface WritingProjectTabState {
  readonly manuscriptId: string;
  readonly openPaths: readonly string[];
  readonly activePath: string | undefined;
  readonly previewPath: string | undefined;
  readonly cursorState: Readonly<Record<string, number>>;
  readonly layoutState: Readonly<Record<string, unknown>>;
}
const identity = (project: string, path: string) => JSON.stringify([project, path]);

/** Presentation state only. Text, review baselines and undo remain file-session owned. */
export class WritingProjectTabs {
  private projects = new Map<string, WritingProjectTabState>();
  private pinned = new Set<string>();
  private listeners = new Set<() => void>();
  private snapshot: readonly WritingProjectTabState[] = [];
  constructor(restored: readonly WritingProjectTabState[] = []) {
    for (const project of restored) {
      this.projects.set(project.manuscriptId,project);
      for (const path of project.openPaths) if (path !== project.previewPath) this.pinned.add(identity(project.manuscriptId,path));
    }
    this.snapshot = [...this.projects.values()];
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (id: string): WritingProjectTabState | undefined => this.projects.get(id);
  sync(input: Omit<WritingProjectTabState, "previewPath">): void {
    const previous = this.projects.get(input.manuscriptId);
    for (const path of previous?.openPaths ?? []) if (!input.openPaths.includes(path)) this.pinned.delete(identity(input.manuscriptId, path));
    const next = { ...input, previewPath: previous?.previewPath && input.openPaths.includes(previous.previewPath) ? previous.previewPath : undefined };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.projects.set(input.manuscriptId, next); this.publish();
  }
  pin(project: string, path: string): void {
    this.pinned.add(identity(project, path));
    const previous = this.projects.get(project);
    if (previous?.previewPath !== path) return;
    this.projects.set(project, { ...previous, previewPath: undefined }); this.publish();
  }
  /** Capture disposition before I/O, so loader metadata and double clicks cannot demote a fixed file. */
  prepareOpen(project: string, path: string, mode: WritingTabMode): () => readonly string[] {
    const previous = this.projects.get(project);
    const fixed = previous?.openPaths.includes(path) && previous.previewPath !== path;
    if (mode === "pinned") this.pin(project, path);
    return () => {
      const current = this.projects.get(project) ?? { manuscriptId: project, openPaths: [], activePath: undefined,
        previewPath: undefined, cursorState: {}, layoutState: {} };
      const preview = mode === "preview" && !fixed && !this.pinned.has(identity(project, path));
      const replaced = preview ? current.previewPath : undefined;
      const paths = current.openPaths.filter(candidate => !replaced || candidate !== replaced || candidate === path || this.pinned.has(identity(project, candidate)));
      const openPaths = paths.includes(path) ? paths : [...paths, path];
      this.projects.set(project, { ...current, openPaths, activePath: path,
        previewPath: preview ? path : current.previewPath === path ? undefined : current.previewPath });
      this.publish(); return openPaths;
    };
  }
  close(project: string, path: string): void {
    const previous = this.projects.get(project);
    if (!previous) return;
    const openPaths = previous.openPaths.filter(candidate => candidate !== path);
    this.projects.set(project, { ...previous, openPaths, activePath: previous.activePath === path ? openPaths.at(-1) : previous.activePath,
      previewPath: previous.previewPath === path ? undefined : previous.previewPath });
    this.pinned.delete(identity(project, path)); this.publish();
  }
  retainProjects(ids: readonly string[]): void {
    const keep = new Set(ids);
    let changed = false;
    for (const [id, project] of this.projects) if (!keep.has(id)) {
      for (const path of project.openPaths) this.pinned.delete(identity(id, path));
      this.projects.delete(id); changed = true;
    }
    if (changed) this.publish();
  }
  private publish(): void { this.snapshot = [...this.projects.values()]; this.listeners.forEach(listener => listener()); }
}
