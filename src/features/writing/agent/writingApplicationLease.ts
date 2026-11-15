import type { AgentApplicationScope, AgentEditorSessionPort, AgentWorkspaceBuffer } from "@research-assistant/core/agent";
import type { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import type { WritingPersistenceControl, WritingSavePause } from "../useWritingPersistence";
import type { WritingApplicationLease } from "./writingProposalApplication";

export interface WritingApplicationHostSnapshot {
  readonly manuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly port: AgentEditorSessionPort | null;
  readonly ready: boolean;
}
interface Options {
  readonly scope: AgentApplicationScope;
  readonly persistence: WritingPersistenceControl;
  readonly access: ReturnType<typeof createExclusiveWritingGateway>;
  /** Return ready=false after unmount or while switching/loading a manuscript. */
  readonly readHost: () => WritingApplicationHostSnapshot;
  /** Read authoritative metadata while protected, return a synchronous UI commit.
   * It must not overwrite active editor text, revision, selection or undo history.
   */
  readonly prepareRefresh: () => Promise<() => void>;
  /** All file-owned buffers, including files with no attached EditorView. */
  readonly readFileBuffers?: () => readonly AgentWorkspaceBuffer[];
  readonly prepareUndoResume?: WritingApplicationLease["prepareUndoResume"];
}

function sameOwners(initial: readonly AgentWorkspaceBuffer[], current: readonly AgentWorkspaceBuffer[]): boolean {
  const byPath = new Map(current.map((buffer) => [buffer.path, buffer]));
  if (initial.length !== current.length || byPath.size !== current.length) return false;
  return initial.every((buffer) => {
    const live = byPath.get(buffer.path);
    return live?.sessionId === buffer.sessionId && live.expectedDiskSha256 === buffer.expectedDiskSha256;
  });
}

/** Acquires both boundaries before taking any baseline. A failed acquisition or
 * unavailable live editor always releases both, without publishing an application.
 */
export async function acquireWritingApplicationLease(options: Options): Promise<WritingApplicationLease | null> {
  const manuscriptId = options.scope.manuscriptId;
  const before = options.readHost();
  if (!before.ready || before.manuscriptId !== manuscriptId) return null;
  const paused: WritingSavePause = await options.persistence.pause();
  let releaseAccess: (() => void) | undefined;
  let transferred = false;
  try {
    releaseAccess = await options.access.acquire();
    const host = options.readHost();
    if (!host.ready || host.manuscriptId !== manuscriptId || host.activePath !== before.activePath || host.port !== before.port) return null;
    const persisted = paused.readSnapshot();
    const editor = host.port?.read();
    let buffers: readonly AgentWorkspaceBuffer[] = [];
    if (host.activePath !== undefined) {
      if (!editor || !persisted || persisted.manuscriptId !== manuscriptId || persisted.relativePath !== host.activePath
        || editor.documentKey !== `${manuscriptId}:${host.activePath}` || persisted.content !== editor.text
        || persisted.saveState === "error" || persisted.saveState === "saving"
        || !persisted.contentHash || !/^[a-f0-9]{64}$/.test(persisted.contentHash)) return null;
      buffers = [{path: host.activePath, expectedDiskSha256: persisted.contentHash,
        sessionId: editor.sessionId, revision: editor.revision, text: editor.text}];
    } else if (host.port || persisted) return null;
    if (options.readFileBuffers) {
      const owned = options.readFileBuffers().map((buffer) => ({ ...buffer }));
      if (new Set(owned.map((buffer) => buffer.path)).size !== owned.length
        || owned.some((buffer) => !/^[a-f0-9]{64}$/.test(buffer.expectedDiskSha256))) return null;
      const active = buffers[0];
      if (active && !owned.some((buffer) => buffer.path === active.path && buffer.sessionId === active.sessionId
        && buffer.revision === active.revision && buffer.text === active.text && buffer.expectedDiskSha256 === active.expectedDiskSha256)) return null;
      buffers = owned;
    }
    let released = false;
    let commit: (() => void) | undefined;
    const ownsHost = () => {
      try {
        const now = options.readHost(), live = host.port?.read();
        return now.ready && now.manuscriptId === manuscriptId && now.activePath === host.activePath
          && now.port === host.port && (!host.port || (!!live && live.documentKey === editor?.documentKey
            && live.sessionId === editor?.sessionId))
          && (!options.readFileBuffers || sameOwners(buffers, options.readFileBuffers()));
      } catch { return false; }
    };
    const isCurrent = () => !released && ownsHost();
    const releaseSource = releaseAccess;
    const lease: WritingApplicationLease = {
      buffers,
      ...(options.prepareUndoResume ? { prepareUndoResume: options.prepareUndoResume } : {}),
      isCurrent,
      readBuffers() {
        if (!isCurrent()) return null;
        if (options.readFileBuffers) return options.readFileBuffers().map((buffer) => ({ ...buffer }));
        if (!host.port) return [];
        const live = host.port.read(), initial = buffers[0];
        if (!live || !initial) return null;
        return [{...initial, sessionId: live.sessionId, revision: live.revision, text: live.text}];
      },
      async refresh() {
        if (!isCurrent()) throw new Error("稿件上下文已变化，未刷新旧操作的界面。");
        const apply = await options.prepareRefresh();
        if (!isCurrent()) throw new Error("稿件上下文已变化，未刷新旧操作的界面。");
        commit = apply;
      },
      release() {
        if (released) return;
        released = true;
        try {
          releaseSource();
          // React effects triggered by metadata can now read source files again.
          if (ownsHost()) commit?.();
        } finally { paused(); }
      },
    };
    transferred = true;
    return lease;
  } finally {
    if (!transferred) { try { releaseAccess?.(); } finally { paused(); } }
  }
}
