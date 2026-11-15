import { parseManuscriptPath, isWritingNotePath, type ManuscriptFileContent, type WritingDocumentIdentity } from "@research-assistant/writing";
import type { WritingGateway } from "../gateway";
import { WritingFileSessions, type WritingFileSession } from "../editor/writingFileSessions";
import type { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import { EDITOR_AUTOSAVE_IDLE_MS } from "@research-assistant/workbench-sdk/document-recovery";

export interface WritingFileSaveEvent extends WritingDocumentIdentity {
  readonly state: "dirty" | "saving" | "saved" | "error";
  readonly reason?: unknown;
}
interface Entry {
  readonly session: WritingFileSession;
  active?: Promise<ManuscriptFileContent> | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  requested: boolean;
  flushRequested: boolean;
  reportFailure: boolean;
}
function key(identity: WritingDocumentIdentity): string { return JSON.stringify([identity.manuscriptId, identity.relativePath]); }

/** One protected formal-file queue per document, shared by active and headless sessions. */
export class WritingFileSaveQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly listeners = new Set<(event: WritingFileSaveEvent) => void>();
  private pauseCount = 0;

  constructor(private readonly files: WritingFileSessions, private readonly checkpoints: WritingCheckpointPersistence,
    private readonly gateway: Pick<WritingGateway, "readFile" | "saveFile">,
    private readonly onError: (reason: unknown, identity: WritingDocumentIdentity) => void) {}

  connect(): () => void {
    const dispose = this.files.subscribeCreated((session) => this.watch(session));
    for (const session of this.files.all()) this.watch(session);
    return () => {
      dispose();
      for (const entry of this.entries.values()) this.clearTimer(entry);
      for (const unsubscribe of this.subscriptions.values()) unsubscribe();
      this.subscriptions.clear();
    };
  }

  subscribe(listener: (event: WritingFileSaveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  save(identity: WritingDocumentIdentity): Promise<ManuscriptFileContent> {
    const entry = this.entries.get(key(identity));
    if (!entry) return Promise.reject(new Error("文件保存会话尚未准备好"));
    return this.saveEntry(entry, true);
  }

  private saveEntry(entry: Entry, immediate: boolean): Promise<ManuscriptFileContent> {
    entry.flushRequested ||= immediate;
    this.clearTimer(entry);
    if (this.pauseCount > 0) {
      entry.requested = true;
      return Promise.reject(new Error("文件保存正在等待独占操作完成"));
    }
    if (entry.active) return entry.active;
    entry.requested = false;
    const operation = this.persist(entry).finally(() => {
      if (entry.active === operation) { entry.active = undefined; entry.flushRequested = false; }
    });
    entry.active = operation;
    return operation;
  }

  async flushAll(): Promise<readonly unknown[]> {
    const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.save(entry.session.identity)));
    return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  }

  /** Admission closes synchronously; all files' in-flight writes finish before the lease is returned. */
  async pause(): Promise<() => void> {
    this.pauseCount += 1;
    await Promise.allSettled([...this.entries.values()].flatMap((entry) => entry.active ? [entry.active] : []));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseCount -= 1;
      if (this.pauseCount === 0) for (const entry of this.entries.values()) {
        if (entry.requested && entry.timer === undefined) this.request(entry);
      }
    };
  }

  private async persist(entry: Entry): Promise<ManuscriptFileContent> {
    const { session } = entry, identity = session.identity;
    let snapshot = session.read();
    const reportFailure = entry.reportFailure;
    try {
      if (this.checkpoints.hasPendingSave(identity)) {
        await this.checkpoints.open(identity.manuscriptId, await this.gateway.readFile(identity.manuscriptId, identity.relativePath));
      }
      if (entry.flushRequested) await this.checkpoints.flush(identity);
      while (true) {
        if (entry.flushRequested) snapshot = session.read();
        const expectedSha256 = session.savedSha256;
        if (!expectedSha256) throw new Error("文件保存缺少已核对的磁盘版本");
        if (this.checkpoints.isSaved(identity)) {
          this.publish(session, "saved");
          return { relativePath: parseManuscriptPath(snapshot.relativePath), content: snapshot.content, sha256: expectedSha256 };
        }
        if (this.pauseCount > 0) { entry.requested = true; throw new Error("文件保存正在等待独占操作完成"); }
        this.publish(session, "saving");
        const intent = await this.checkpoints.beginSave(snapshot, expectedSha256);
        const trace = { phase: "formal-save" as const, source: "save-queue" as const, operationId: intent.operationId,
          before: snapshot, after: snapshot, expectedSha256, targetSha256: intent.targetSha256 };
        session.trace({ ...trace, status: "started" });
        let saved: ManuscriptFileContent;
        try {
          saved = await this.gateway.saveFile({ manuscriptId: identity.manuscriptId, relativePath: parseManuscriptPath(snapshot.relativePath),
            content: snapshot.content, expectedSha256 });
          session.trace({ ...trace, status: "completed", savedSha256: saved.sha256 });
        } catch (reason) { session.trace({ ...trace, status: "failed" }); throw reason; }
        await this.checkpoints.completeSave(identity, intent, saved.sha256);
        if (session.read().version === snapshot.version) {
          this.publish(session, "saved");
          return saved;
        }
        this.publish(session, "dirty");
        if (this.pauseCount > 0) { entry.requested = true; return saved; }
        if (!entry.flushRequested && entry.timer !== undefined) return saved;
        snapshot = session.read();
      }
    } catch (reason) {
      this.publish(session, "error", reason);
      if (reportFailure) this.onError(reason, identity);
      throw reason;
    }
  }

  private watch(session: WritingFileSession): void {
    const identity = key(session.identity);
    if (isWritingNotePath(session.identity.relativePath) || this.subscriptions.has(identity)) return;
    const entry = this.entries.get(identity) ?? { session, requested: false, flushRequested: false, reportFailure: true };
    this.entries.set(identity, entry);
    this.subscriptions.set(identity, session.subscribe((change) => {
      if (change.diskReloaded) { entry.requested = false; this.clearTimer(entry); this.publish(session, "saved"); return; }
      entry.requested = true;
      entry.reportFailure = !change.agent;
      this.publish(session, "dirty");
      this.clearTimer(entry);
      if (change.immediate) { entry.flushRequested = true; this.request(entry); }
      else entry.timer = setTimeout(() => this.request(entry), EDITOR_AUTOSAVE_IDLE_MS);
    }));
  }

  private request(entry: Entry): void {
    this.clearTimer(entry);
    if (this.pauseCount > 0) return;
    // Errors remain in the queue state/result. Agent-owned writes are consumed
    // by their operation owner instead of becoming user notifications.
    void this.saveEntry(entry, false).catch(() => undefined);
  }
  private clearTimer(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  private publish(session: WritingFileSession, state: WritingFileSaveEvent["state"], reason?: unknown): void {
    for (const listener of this.listeners) listener({ ...session.identity, state, ...(reason === undefined ? {} : { reason }) });
  }
}
