import { decodeWritingDocumentCheckpoint, isWritingNotePath, isWritingSourcePath, type ManuscriptFileContent, type WritingCheckpointRecord, type WritingCheckpointWrite, type WritingDocumentOperation,
  type WritingDocumentIdentity, type WritingDocumentSaveIntent, type WritingDocumentSnapshot } from "@research-assistant/writing";
import type { WritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import type { AgentEditorEdit, AgentEditorEditResult, AgentUndoCheckpointVersion } from "@research-assistant/core/agent";
import { WritingFileSessions, type WritingFileSession } from "../editor/writingFileSessions";
import { persistReviewSnapshots } from "@research-assistant/core/document-review";
import { EDITOR_AUTOSAVE_IDLE_MS } from "@research-assistant/workbench-sdk/document-recovery";

interface Entry {
  readonly session: WritingFileSession;
  record: WritingCheckpointRecord | undefined;
  initialized: boolean;
  savedSha256: string | undefined;
  savedVersion: number;
  intent: WritingDocumentSaveIntent | null;
  pendingWrite: WritingCheckpointWrite | undefined;
  tail: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  blocked: boolean;
  reportFailure: boolean;
}

function key(identity: WritingDocumentIdentity): string { return JSON.stringify([identity.manuscriptId, identity.relativePath]); }
function conflict(): never { throw Object.assign(new Error("文件已被外部修改，请先比较当前编辑内容。"), { code: "file_conflict" }); }

async function hashText(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** File-owned checkpoint queue. Formal writes remain in the protected WritingGateway. */
export class WritingCheckpointPersistence {
  private readonly records = new Map<string, WritingCheckpointRecord>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly entries = new Map<string, Entry>();
  private readonly subscriptions = new Map<string, () => void>();

  constructor(private readonly files: WritingFileSessions, private readonly gateway: WritingCheckpointGateway,
    private readonly onError: (reason: unknown) => void,
    private readonly hash: (content: string) => Promise<string> = hashText) {}

  /** Subscribe at the owning lifecycle boundary, not during React construction. */
  connect(): () => void {
    const unsubscribe = this.files.subscribeCreated((session) => this.watch(session));
    for (const session of this.files.all()) this.watch(session);
    return () => {
      unsubscribe();
      void this.flushAll().catch(this.onError);
      for (const dispose of this.subscriptions.values()) dispose();
      this.subscriptions.clear();
    };
  }

  hasCheckpoint(identity: WritingDocumentIdentity): boolean { return this.records.has(key(identity)); }

  /** Install a confirmed system migration without resetting editor history or
   * rewriting immutable Agent delivery receipts. The caller holds the save lease. */
  acceptCitationMigration(migration: import("../citations/citationKeyMigration").CitationKeyMigration): void {
    for (const record of migration.checkpoints) {
      const identity = record.checkpoint;
      const entry = this.entries.get(key(identity));
      this.records.set(key(identity),record);
      if (!entry) continue;
      if (entry.intent || entry.pendingWrite) throw new Error("引用键迁移遇到尚未核对的文件保存");
      entry.record = record;
      entry.savedSha256 = identity.savedSha256;
      entry.savedVersion = identity.savedVersion;
      entry.session.rekeyCitations(migration.assignments);
      const snapshot = entry.session.read();
      if (snapshot.version !== identity.version || snapshot.content !== identity.content || snapshot.reviewBaseline !== identity.reviewBaseline) throw new Error("引用键迁移回执与编辑会话不一致");
      entry.session.recordSaved(identity.savedSha256);
    }
  }
  hasPendingSave(identity: WritingDocumentIdentity): boolean {
    return this.entries.get(key(identity))?.intent != null;
  }

  isSaved(identity: WritingDocumentIdentity): boolean {
    const entry = this.entries.get(key(identity));
    return entry?.initialized === true && !entry.intent && !entry.blocked && entry.savedVersion === entry.session.read().version;
  }

  load(manuscriptId: string): Promise<void> {
    let pending = this.loads.get(manuscriptId);
    if (!pending) {
      pending = this.gateway.list(manuscriptId).then((rows) => {
        for (const row of rows) this.records.set(key(row.checkpoint), row);
      }).catch((reason: unknown) => { this.loads.delete(manuscriptId); throw reason; });
      this.loads.set(manuscriptId, pending);
    }
    return pending;
  }

  /** Rehydrate checkpointed source files without opening tabs or replaying edits.
   * The existing open boundary reconciles save intents and protects external bytes.
   */
  async restoreBackground(manuscriptId: string, readFile: (path: string) => Promise<ManuscriptFileContent>,
    isCurrent: () => boolean, onConflict: (snapshot: WritingDocumentSnapshot) => void): Promise<void> {
    await this.load(manuscriptId);
    for (const { checkpoint } of this.records.values()) {
      if (!isCurrent()) return;
      if (checkpoint.manuscriptId !== manuscriptId || !isWritingSourcePath(checkpoint.relativePath)) continue;
      const existing = this.files.get(checkpoint);
      const entry = this.entries.get(key(checkpoint));
      if (existing && entry?.blocked !== true) {
        // Opening may have reconciled disk before its checkpoint reply failed.
        // Settle that exact write without reopening or resetting a live save intent.
        if (entry?.pendingWrite) await this.flush(checkpoint);
        continue;
      }
      const disk = await readFile(checkpoint.relativePath);
      if (!isCurrent()) return;
      if (disk.relativePath !== checkpoint.relativePath) throw new Error("后台文件读取身份不匹配");
      try { await this.open(manuscriptId, disk); }
      catch (reason) {
        if (!isCurrent()) return;
        const session = this.files.get(checkpoint);
        if (session && typeof reason === "object" && reason !== null && "code" in reason && reason.code === "file_conflict") {
          onConflict(session.read());
        }
        throw reason;
      }
    }
  }

  /** Disk hashes distinguish an interrupted save from an external edit. Neither replays history. */
  async open(manuscriptId: string, disk: ManuscriptFileContent): Promise<WritingFileSession> {
    const identity = { manuscriptId, relativePath: disk.relativePath };
    try { await this.load(manuscriptId); }
    catch (reason) {
      this.files.diagnostics.record({ ...identity, phase: "recovery", source: "checkpoint-restore", status: "failed", targetSha256: disk.sha256 });
      throw reason;
    }
    const record = this.records.get(key(identity));
    const session = this.files.get(identity) ?? (record
      ? this.files.restore(record.checkpoint) : this.files.open(identity, disk.content, disk.sha256));
    this.watch(session);
    const entry = this.entries.get(key(identity));
    if (!entry) throw new Error("无法恢复此文件的编辑检查点");
    try { await this.initialize(entry); }
    catch (reason) { session.trace({ phase: "recovery", source: "checkpoint-restore", status: "failed", targetSha256: disk.sha256 }); throw reason; }
    const intent = entry.intent;
    const recovery = { phase: "recovery" as const, before: session.read(), savedVersion: entry.savedVersion,
      ...(entry.savedSha256 ? { expectedSha256: entry.savedSha256 } : {}), targetSha256: disk.sha256,
      ...(intent ? { operationId: intent.operationId } : {}) };
    const source = intent?.targetSha256 === disk.sha256 ? "intent-written" : entry.savedSha256 === disk.sha256
      ? intent ? "intent-not-written" : "disk-match" : "disk-conflict";
    const operationId = session.trace({ ...recovery, source, status: "started" });
    const observation = { ...recovery, ...(operationId ? { operationId } : {}) };
    try {
      if (intent?.targetSha256 === disk.sha256) {
        entry.blocked = false;
        entry.savedSha256 = disk.sha256;
        entry.savedVersion = intent.version;
        entry.intent = null;
        session.recordSaved(disk.sha256);
        await this.flush(session.identity);
      } else if (entry.savedSha256 === disk.sha256) {
        entry.blocked = false;
        // An intent was recorded but its atomic file replacement did not happen.
        if (intent) { entry.intent = null; await this.flush(session.identity); }
      } else {
        entry.blocked = true;
        conflict();
      }
      session.observeDisk(disk.content, disk.sha256);
      session.trace({ ...observation, source, status: "completed", savedVersion: entry.savedVersion });
      return session;
    } catch (reason) { session.trace({ ...observation, source, status: source === "disk-conflict" ? "conflict" : "failed" }); throw reason; }
  }

  async beginSave(snapshot: WritingDocumentSnapshot, expectedSha256: string): Promise<WritingDocumentSaveIntent> {
    const entry = this.requireEntry(snapshot);
    await this.initialize(entry);
    if (entry.blocked || entry.savedSha256 !== expectedSha256) conflict();
    if (entry.intent) throw new Error("上次文件保存尚未核对完成，请重新打开文件核对状态。");
    const targetSha256 = await this.hash(snapshot.content);
    if (entry.intent || entry.savedSha256 !== expectedSha256 || snapshot.version < entry.savedVersion) conflict();
    const intent = { operationId: crypto.randomUUID(), version: snapshot.version, expectedSha256, targetSha256 };
    entry.intent = intent;
    const trace = { phase: "save-intent" as const, source: "save-queue" as const, operationId: intent.operationId,
      before: snapshot, expectedSha256, targetSha256, savedVersion: entry.savedVersion };
    entry.session.trace({ ...trace, status: "started" });
    try { await this.flushEntry(entry, "boundary"); entry.session.trace({ ...trace, status: "completed" }); }
    catch (reason) { entry.session.trace({ ...trace, status: "failed" }); throw reason; }
    return intent;
  }

  async completeSave(identity: WritingDocumentIdentity, intent: WritingDocumentSaveIntent, sha256: string): Promise<void> {
    const entry = this.requireEntry(identity);
    if (entry.intent !== intent || sha256 !== intent.targetSha256) throw new Error("文件保存回执与写入意图不匹配");
    const before = this.files.diagnostics.enabled ? entry.session.read() : undefined;
    entry.savedSha256 = sha256;
    entry.savedVersion = intent.version;
    entry.intent = null;
    entry.session.recordSaved(sha256);
    // Capture the latest D/B, not the old state which happened to be written to disk.
    const trace = { phase: "save-intent" as const, source: "save-complete" as const, operationId: intent.operationId,
      expectedSha256: intent.expectedSha256, targetSha256: intent.targetSha256, savedVersion: intent.version,
      ...(before ? { before } : {}) };
    entry.session.trace({ ...trace, status: "started" });
    try { await this.flushEntry(entry, "boundary"); entry.session.trace({ ...trace, status: "completed" }); }
    catch (reason) { entry.session.trace({ ...trace, status: "failed" }); throw reason; }
  }

  /** Success means D/B and immutable delivery credentials are reliably checkpointed. */
  async applyAgent(identity: WritingDocumentIdentity, source: WritingDocumentOperation, expectedVersion: number, content: string): Promise<"applied" | "duplicate" | "conflict"> {
    const entry = this.requireEntry(identity);
    await this.initialize(entry);
    if (entry.blocked || await this.hash(content) !== source.resultSha256 || entry.blocked) return "conflict";
    const validated = decodeWritingDocumentCheckpoint({ schemaVersion: 1, ...entry.session.read(), savedSha256: entry.savedSha256,
      savedVersion: entry.savedVersion, operations: [source], saveIntent: null }).operations[0]!;
    const result = entry.session.applyAgent(validated.operationId, expectedVersion, content, validated);
    if (result !== "conflict") await this.flush(identity);
    return result;
  }

  /** Native CAS and receipt remain authoritative; provenance and D/B settle before ACK. */
  async applyEditorAgent(identity: WritingDocumentIdentity, source: Omit<WritingDocumentOperation, "resultSha256">, edit: AgentEditorEdit): Promise<AgentEditorEditResult> {
    source = { ...source };
    edit = { ...edit, expected: { ...edit.expected } };
    const entry = this.requireEntry(identity);
    await this.initialize(entry);
    if (entry.blocked) return { status: "conflict" };
    const resultSha256 = await this.hash(edit.text);
    if (entry.blocked) return { status: "conflict" };
    const validated = decodeWritingDocumentCheckpoint({ schemaVersion: 1, ...entry.session.read(), savedSha256: entry.savedSha256,
      savedVersion: entry.savedVersion, operations: [{ ...source, resultSha256 }], saveIntent: null }).operations[0]!;
    const result = entry.session.applyEditorAgent(edit, validated);
    if (result.status === "applied" || entry.session.applicationPort.readReceipt(edit.operationId)) await this.flush(identity);
    return result;
  }

  /** Retry persistence of observed delivery; never dispatch its historical text again. */
  async settleEditorAgent(identity: WritingDocumentIdentity, source: Omit<WritingDocumentOperation, "resultSha256">): Promise<boolean> {
    source = { ...source };
    const entry = this.requireEntry(identity);
    await this.initialize(entry);
    const receipt = entry.session.applicationPort.readReceipt(source.operationId);
    const operation = entry.session.readOperations().find((record) => record.operationId === source.operationId);
    if (!receipt || !operation || operation.conversationId !== source.conversationId || operation.requestId !== source.requestId
      || operation.resultSha256 !== await this.hash(receipt.snapshot.text)) return false;
    await this.flush(identity);
    return true;
  }

  flush(identity: WritingDocumentIdentity): Promise<void> {
    return this.flushEntry(this.requireEntry(identity), "latest");
  }

  private flushEntry(entry: Entry, mode: "latest" | "idle" | "boundary"): Promise<void> {
    if (mode !== "boundary") this.clearTimers(entry);
    const operation = entry.tail.catch(() => undefined).then(async () => {
      await this.initialize(entry);
      // An external disk conflict prevents formal writes, not reliable recovery of D/B.
      // Retry an uncertain response with its exact write before advancing to a newer snapshot.
      if (entry.pendingWrite) await this.write(entry, entry.pendingWrite);
      if (!entry.savedSha256) throw new Error("文件检查点缺少已保存版本，请先保存文件。");
      let captured = false;
      await persistReviewSnapshots({
        capture: () => {
          if ((mode === "idle" && entry.timer !== undefined) || (mode === "boundary" && captured)) return undefined;
          captured = true;
          const savedSha256 = entry.savedSha256;
          if (!savedSha256) throw new Error("文件检查点缺少已保存版本，请先保存文件。");
          const editorReceipt = entry.session.readEditorReceipt();
          return { schemaVersion: 1 as const, ...entry.session.read(), savedSha256,
            savedVersion: entry.savedVersion, operations: entry.session.readOperations(), saveIntent: entry.intent,
            ...(editorReceipt ? { editorReceipt } : {}) };
        },
        prepare: checkpoint => !checkpoint || JSON.stringify(entry.record?.checkpoint) === JSON.stringify(checkpoint) ? null
          : { expectedRevision: entry.record?.revision ?? null, checkpoint },
        write: write => this.write(entry, write),
      });
      if (mode === "latest" || (mode === "idle" && entry.timer === undefined)) this.clearTimers(entry);
    });
    entry.tail = operation;
    return operation;
  }

  async flushAll(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.flush(entry.session.identity)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  /** Capture reliable current D/B evidence while the host pauses formal saves.
   * Input during the flush must be checkpointed too; uncertain writes never admit Undo. */
  async captureUndoCheckpointVersions(manuscriptId: string): Promise<readonly AgentUndoCheckpointVersion[]> {
    const entries = [...this.entries.values()].filter(entry => entry.session.identity.manuscriptId === manuscriptId);
    await Promise.all(entries.map(entry => this.flush(entry.session.identity)));
    return entries.map(entry => {
      const record = entry.record, current = entry.session.read();
      if (!record || entry.pendingWrite || entry.blocked || entry.intent || !entry.initialized
        || record.checkpoint.version !== current.version || record.checkpoint.content !== current.content
        || record.checkpoint.reviewBaseline !== current.reviewBaseline) throw new Error("撤销恢复需要最新可靠文件检查点");
      return { path: current.relativePath, revision: record.revision, stateVersion: current.version };
    });
  }

  private async write(entry: Entry, write: WritingCheckpointWrite): Promise<void> {
    entry.pendingWrite = write;
    const trace = { phase: "checkpoint" as const, source: "checkpoint-queue" as const,
      operationId: write.checkpoint.saveIntent?.operationId ?? `checkpoint:${key(write.checkpoint)}:${write.expectedRevision ?? "initial"}:${write.checkpoint.version}`,
      ...(entry.record ? { before: entry.record.checkpoint } : {}), after: write.checkpoint,
      savedVersion: write.checkpoint.savedVersion, savedSha256: write.checkpoint.savedSha256 };
    entry.session.trace({ ...trace, status: "started" });
    try {
      const record = await this.gateway.save(write);
      entry.record = record;
      this.records.set(key(record.checkpoint), record);
      entry.pendingWrite = undefined;
      entry.session.trace({ ...trace, status: "completed" });
    } catch (reason) { entry.session.trace({ ...trace, status: "failed" }); throw reason; }
  }

  private watch(session: WritingFileSession): void {
    if (isWritingNotePath(session.identity.relativePath) || this.subscriptions.has(key(session.identity))) return;
    const entry: Entry = this.entries.get(key(session.identity)) ?? { session, record: undefined, initialized: false, savedSha256: undefined, savedVersion: 0,
      intent: null, pendingWrite: undefined, tail: Promise.resolve(), timer: undefined, blocked: false, reportFailure: true };
    this.entries.set(key(session.identity), entry);
    const unsubscribe = session.subscribe((change) => {
      entry.reportFailure = !change.agent;
      if (change.diskReloaded) {
        entry.savedSha256 = session.savedSha256;
        entry.savedVersion = session.read().version;
        entry.intent = null;
        entry.blocked = false;
      }
      if (change.immediate) this.schedule(entry);
      else {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.schedule(entry), EDITOR_AUTOSAVE_IDLE_MS);
      }
    });
    this.subscriptions.set(key(session.identity), unsubscribe);
  }

  private schedule(entry: Entry): void {
    const reportFailure = entry.reportFailure;
    void this.flushEntry(entry, "idle").catch(reason => { if (reportFailure) this.onError(reason); });
  }

  private clearTimers(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private async initialize(entry: Entry): Promise<void> {
    if (entry.initialized) return;
    await this.load(entry.session.identity.manuscriptId);
    if (entry.initialized) return;
    const record = this.records.get(key(entry.session.identity));
    if (record) entry.session.restoreOperations(record.checkpoint.operations, record.checkpoint.editorReceipt);
    entry.record = record;
    entry.savedSha256 = record?.checkpoint.savedSha256 ?? entry.session.savedSha256;
    entry.savedVersion = record?.checkpoint.savedVersion ?? 0;
    entry.intent = record?.checkpoint.saveIntent ?? null;
    entry.initialized = true;
  }

  private requireEntry(identity: WritingDocumentIdentity): Entry {
    const entry = this.entries.get(key(identity));
    if (!entry) throw new Error("文件编辑会话尚未准备好");
    return entry;
  }
}
