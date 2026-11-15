import { isolateHistory } from "@codemirror/commands";
import { getChunks, getOriginalDoc, originalDocChangeEffect } from "@codemirror/merge";
import { Compartment, EditorState, StateEffect, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { decodeWritingDocumentCheckpoint, isWritingSourcePath, parseManuscriptPath, type WritingDocumentCheckpoint, type WritingDocumentEditorReceipt, type WritingDocumentIdentity, type WritingDocumentOperation, type WritingDocumentSnapshot } from "@research-assistant/writing";
import type { AgentEditorEdit, AgentEditorEditResult, AgentEditorSessionPort, AgentWorkspaceBuffer } from "@research-assistant/core/agent";
import { captureWritingEditor } from "./editorSession";
import { createWritingStateSessionPort } from "./editorSessionPort";
import { createLatexEditorState, editorHostCompartment, editorHostExtensions, type EditorStateOptions } from "./editorState";
import { writingDiffResolution, writingTextChanges } from "./writingDiffCommands";
import { configuredWritingDiagnostics, WritingStateDiagnostics, type WritingDiagnosticInput } from "../persistence/WritingStateDiagnostics";
import { sameReviewDocument } from "@research-assistant/core/document-review";
import { canonicalCitationTransaction, citationMigrationTransaction } from "./extensions/citationIdentity";

interface FileOperationReceipt { readonly content?: string; readonly source?: WritingDocumentOperation }

/** One CodeMirror state/history per file, with at most one attached view. */
export class WritingFileSession {
  private current: EditorState;
  private view: EditorView | null = null;
  private version = 0;
  private opened = false;
  private readonly operations = new Map<string, FileOperationReceipt>();
  private readonly listeners = new Set<(change: WritingFileChange) => void>();
  private scroll = { top: 0, left: 0 };
  private savedHash: string | undefined;
  private port: AgentEditorSessionPort | undefined;
  private livePort: AgentEditorSessionPort | undefined;
  private editorReceipt: WritingDocumentEditorReceipt | undefined;
  private dispatchOperationId: string | undefined;
  private readonly citationLock = new Compartment();
  private citationLocked = false;

  constructor(readonly identity: WritingDocumentIdentity, content: string, sha256?: string, restored?: WritingDocumentSnapshot & {
    readonly operations?: readonly WritingDocumentOperation[]; readonly editorReceipt?: WritingDocumentEditorReceipt },
    private readonly diagnostics = new WritingStateDiagnostics()) {
    this.savedHash = sha256;
    this.version = restored?.version ?? 0;
    this.current = createLatexEditorState({ content: restored?.content ?? content, filePath: identity.relativePath,
      ...(restored ? { reviewBaseline: restored.reviewBaseline } : {}),
      onChange: () => undefined, onCursorChange: () => undefined,
      onCompile: () => undefined, onOpenCommands: () => undefined,
      getCompletionData: () => ({ citationKeys: [], files: [], labels: [] }), codeCheckEnabled: false });
    this.current = this.current.update({effects:StateEffect.appendConfig.of(this.citationLock.of([]))}).state;
    if (restored?.operations) this.restoreOperations(restored.operations, restored.editorReceipt);
    this.trace({ phase: "install", source: restored ? "checkpoint-restore" : "disk-open", status: "completed" });
  }

  trace(input: Omit<WritingDiagnosticInput, "manuscriptId" | "relativePath">): string | undefined {
    if (!this.diagnostics.enabled) return;
    return this.diagnostics.record({ ...(this.savedHash ? { savedSha256: this.savedHash } : {}), ...input, ...this.identity,
      after: input.after ?? this.read() });
  }

  get state(): EditorState { return this.current; }
  get hasBeenOpened(): boolean { return this.opened; }
  get pending(): boolean { return (getChunks(this.current)?.chunks.length ?? 0) > 0; }
  get savedSha256(): string | undefined { return this.savedHash; }
  get applicationPort(): AgentEditorSessionPort {
    if (this.port) return this.port;
    const documentKey = `${this.identity.manuscriptId}:${this.identity.relativePath}`;
    const live = this.livePort = createWritingStateSessionPort({ documentKey,
      readState: () => this.current, isComposing: () => this.view?.composing ?? false,
      dispatch: (transaction) => { if (this.view) this.view.dispatch(transaction); else this.accept([transaction]); } });
    return this.port = { read: live.read, apply: (edit) => {
      this.dispatchOperationId = edit.operationId;
      try { return live.apply(edit); } finally { this.dispatchOperationId = undefined; }
    }, readReceipt: (operationId) => {
      const observed = live.readReceipt(operationId), receipt = this.editorReceipt;
      if (observed) return observed;
      return receipt?.operationId === operationId ? { status: "applied", operationId, snapshot: {
        documentKey, sessionId: receipt.sessionId, revision: receipt.revision, text: receipt.text,
      } } : null;
    } };
  }

  observeDisk(content: string, sha256: string): void {
    if (this.savedHash !== undefined && this.savedHash !== sha256 && this.current.doc.toString() !== content) {
      throw Object.assign(new Error("文件已被外部修改，请先比较当前编辑内容。"), { code: "file_conflict" });
    }
    this.savedHash = sha256;
  }

  recordSaved(sha256: string): void { this.savedHash = sha256; }

  rekeyCitations(assignments: readonly import("@research-assistant/writing").CitationKeyAssignment[]): void {
    this.dispatch(citationMigrationTransaction(this.current, assignments));
  }

  lockCitationMigration(): () => void {
    if (this.view?.composing) throw new Error("请完成当前输入后再更新引用键。");
    this.citationLocked = true;
    this.dispatch({effects:this.citationLock.reconfigure(EditorState.readOnly.of(true))});
    return () => {this.citationLocked = false;this.dispatch({effects:this.citationLock.reconfigure([])});};
  }

  reloadDisk(content: string, sha256: string): void {
    const before = getOriginalDoc(this.current).toString();
    const version = this.version;
    this.savedHash = sha256;
    this.dispatch({ changes: writingTextChanges(this.current.doc.toString(), content),
      effects: originalDocChangeEffect(this.current, writingTextChanges(before, content)),
      annotations: [Transaction.userEvent.of("input.restore"), isolateHistory.of("full")] });
    if (this.version === version) for (const listener of this.listeners) listener({ immediate: true, diskReloaded: true });
  }

  read(): WritingDocumentSnapshot {
    return { ...this.identity, version: this.version, content: this.current.doc.toString(),
      reviewBaseline: getOriginalDoc(this.current).toString() };
  }

  subscribe(listener: (change: WritingFileChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readOperations(): readonly WritingDocumentOperation[] {
    return [...this.operations.values()].flatMap((entry) => entry.source ? [{ ...entry.source }] : []);
  }

  readEditorReceipt(): WritingDocumentEditorReceipt | undefined {
    return this.editorReceipt ? { ...this.editorReceipt } : undefined;
  }

  /** Persistence seeds immutable credentials before accepting new delivery. */
  restoreOperations(records: readonly WritingDocumentOperation[], receipt?: WritingDocumentEditorReceipt): void {
    const next = new Map<string, FileOperationReceipt>(records.map((source) => [source.operationId, { source: { ...source } }]));
    for (const [id, entry] of this.operations) {
      const previous = next.get(id);
      if (previous && JSON.stringify(previous.source) !== JSON.stringify(entry.source)) {
        throw Object.assign(new Error("文件修改的操作身份不一致，请重新核对。"), { code: "checkpoint_conflict" });
      }
      if (!previous) next.set(id, entry);
    }
    if (receipt) {
      if (!next.has(receipt.operationId) || (this.editorReceipt && JSON.stringify(this.editorReceipt) !== JSON.stringify(receipt))) {
        throw Object.assign(new Error("文件修改的历史回执不一致，请重新核对。"), { code: "checkpoint_conflict" });
      }
    }
    this.operations.clear();
    for (const [id, entry] of next) this.operations.set(id, entry);
    if (receipt) this.editorReceipt = { ...receipt };
  }

  configureHost(options: EditorStateOptions): EditorState {
    if (this.view) throw new Error("Cannot replace a file host while its view is attached");
    this.current = this.current.update({ effects: editorHostCompartment.reconfigure(editorHostExtensions(options)) }).state;
    return this.current;
  }

  attach(view: EditorView): void {
    if (this.view || view.state !== this.current) throw new Error("File editor state does not match its session");
    this.view = view;
    this.opened = true;
    view.scrollDOM.scrollTop = this.scroll.top;
    view.scrollDOM.scrollLeft = this.scroll.left;
  }

  detach(view: EditorView): void {
    if (this.view !== view) return;
    this.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    this.view = null;
    // Remove callbacks into the old host. State/history remain file-owned.
    this.current = this.current.update({ effects: editorHostCompartment.reconfigure([]) }).state;
  }

  accept(transactions: readonly Transaction[]): void {
    if (this.citationLocked && transactions.some(tr => !tr.isUserEvent("input.citation-key")
      && (tr.docChanged || !getOriginalDoc(tr.startState).eq(getOriginalDoc(tr.state))))) return;
    const start = this.current;
    const before = this.diagnostics.enabled ? this.read() : undefined;
    let next = start;
    for (const transaction of transactions) {
      if (transaction.startState !== next) throw new Error("Stale file transaction");
      next = transaction.state;
    }
    if (transactions.some(tr => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) {
      const normalization = canonicalCitationTransaction(next);
      if (normalization) {
        const normalized = next.update(normalization);
        transactions = [...transactions,normalized];
        next = normalized.state;
      }
    }
    this.current = next;
    const changed = !sameReviewDocument({ content: start.doc, reviewBaseline: getOriginalDoc(start) },
      { content: next.doc, reviewBaseline: getOriginalDoc(next) }, (a, b) => a.eq(b));
    if (changed) this.version += 1;
    if (changed) {
      const source = (["input.restore", "input.agent", "review", "undo", "redo"] as const)
        .find(event => transactions.some(transaction => transaction.isUserEvent(event)));
      this.trace({ phase: "install", source: source === "input.restore" ? "disk-reload"
        : source === "input.agent" ? "agent" : source ?? "input", status: "completed",
        ...(before ? { before } : {}), ...(source === "input.agent" && this.dispatchOperationId ? { operationId: this.dispatchOperationId } : {}) });
    }
    this.view?.update(transactions);
    if (changed) {
      const diskReloaded = transactions.some((transaction) => transaction.isUserEvent("input.restore"));
      const immediate = diskReloaded || transactions.some((transaction) =>
        ["input.agent", "review", "undo", "redo"].some((event) => transaction.isUserEvent(event)));
      const agent = transactions.some(transaction => transaction.isUserEvent("input.agent"));
      for (const listener of this.listeners) listener({ immediate, diskReloaded, agent });
    }
  }

  dispatch(spec: TransactionSpec): void {
    if (this.view) this.view.dispatch(spec);
    else this.accept([this.current.update(spec)]);
  }

  resolveAll(action: "keep" | "undo"): boolean {
    if (this.view?.composing) return false;
    const transaction = writingDiffResolution(this.current, action);
    if (!transaction) return false;
    this.dispatch(transaction);
    return true;
  }

  /** Retain provenance before the native transaction notifies persistence listeners. */
  applyEditorAgent(edit: AgentEditorEdit, source: WritingDocumentOperation): AgentEditorEditResult {
    if (source.operationId !== edit.operationId) return { status: "conflict" };
    const previous = this.operations.get(edit.operationId);
    if (previous) {
      if (JSON.stringify(previous.source) !== JSON.stringify(source)) return { status: "conflict" };
      // A restored credential proves prior delivery, never authorizes another dispatch.
      return this.livePort?.readReceipt(edit.operationId) ?? { status: "unconfirmed" };
    }
    const start = this.current;
    this.operations.set(edit.operationId, { source: { ...source } });
    try {
      const result = this.applicationPort.apply(edit);
      if (this.current === start) this.operations.delete(edit.operationId);
      return result;
    } catch (reason) {
      if (this.current === start) this.operations.delete(edit.operationId);
      throw reason;
    } finally {
      // Dispatch listeners can throw after the port has observed its result.
      // Preserve that observation for settlement; never reconstruct it from D.
      const receipt = this.livePort?.readReceipt(edit.operationId);
      if (receipt) this.editorReceipt = { operationId: receipt.operationId, sessionId: receipt.snapshot.sessionId,
        revision: receipt.snapshot.revision, text: receipt.snapshot.text, stateVersion: this.version };
    }
  }

  /** Delivery is explicit, version guarded and independent of history views. */
  applyAgent(operationId: string, expectedVersion: number, content: string, source?: WritingDocumentOperation): "applied" | "duplicate" | "conflict" {
    const previous = this.operations.get(operationId);
    if (previous !== undefined) return source
      ? JSON.stringify(previous.source) === JSON.stringify(source) ? "duplicate" : "conflict"
      : previous.content === content ? "duplicate" : "conflict";
    if (expectedVersion !== this.version || this.current.readOnly || this.view?.composing) return "conflict";
    if (source && source.operationId !== operationId) return "conflict";
    const transaction = this.current.update({ changes: writingTextChanges(this.current.doc.toString(), content),
      annotations: [Transaction.userEvent.of("input.agent"), isolateHistory.of("full")] });
    if (transaction.newDoc.toString() !== content) return "conflict";
    // Provenance must be visible to checkpoint listeners in the same transaction.
    this.operations.set(operationId, source ? { source: { ...source } } : { content });
    this.dispatchOperationId = operationId;
    try {
      if (this.view) this.view.dispatch(transaction);
      else this.accept([transaction]);
    } catch (reason) {
      if (this.current === transaction.startState) this.operations.delete(operationId);
      throw reason;
    } finally { this.dispatchOperationId = undefined; }
    if (source && !transaction.docChanged) for (const listener of this.listeners) listener({ immediate: true, diskReloaded: false, agent: true });
    return "applied";
  }
}

export interface WritingFileChange {
  readonly immediate: boolean;
  readonly diskReloaded: boolean;
  readonly agent?: boolean;
}

/** Owned by the manuscript workspace, never by a conversation panel. */
export class WritingFileSessions {
  private readonly files = new Map<string, WritingFileSession>();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly createdListeners = new Set<(session: WritingFileSession) => void>();
  constructor(readonly diagnostics = configuredWritingDiagnostics()) {}
  readonly getRevision = (): number => this.revision;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(identity: WritingDocumentIdentity): WritingFileSession | undefined {
    return this.files.get(this.key(identity));
  }

  open(identity: WritingDocumentIdentity, content: string, sha256?: string): WritingFileSession {
    const key = this.key(identity);
    let session = this.files.get(key);
    if (!session) {
      session = new WritingFileSession({ ...identity, relativePath: parseManuscriptPath(identity.relativePath) }, content, sha256, undefined, this.diagnostics);
      this.add(key, session);
    } else if (sha256 !== undefined) session.observeDisk(content, sha256);
    return session;
  }

  /** Restoring starts a fresh process history, never installs dialogue snapshots. */
  restore(value: WritingDocumentCheckpoint): WritingFileSession {
    const checkpoint = decodeWritingDocumentCheckpoint(value), key = this.key(checkpoint);
    const existing = this.files.get(key);
    if (existing) return existing;
    const identity = { manuscriptId: checkpoint.manuscriptId, relativePath: checkpoint.relativePath };
    const session = new WritingFileSession(identity, checkpoint.content, checkpoint.savedSha256, checkpoint, this.diagnostics);
    this.add(key, session);
    return session;
  }

  all(): readonly WritingFileSession[] { return [...this.files.values()]; }

  subscribeCreated(listener: (session: WritingFileSession) => void): () => void {
    this.createdListeners.add(listener);
    return () => this.createdListeners.delete(listener);
  }

  private add(key: string, session: WritingFileSession): void {
    this.files.set(key, session);
    session.subscribe(() => {
      this.revision += 1;
      for (const listener of this.listeners) listener();
    });
    for (const listener of this.createdListeners) listener(session);
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  forManuscript(manuscriptId: string): readonly WritingFileSession[] {
    return [...this.files.values()].filter((session) => session.identity.manuscriptId === manuscriptId);
  }

  /** Submission and execution-copy preparation consume the same current file bytes. */
  readBuffers(manuscriptId: string): readonly AgentWorkspaceBuffer[] {
    return this.forManuscript(manuscriptId).flatMap((session) => {
      const expectedDiskSha256 = session.savedSha256, path = session.identity.relativePath;
      if (!expectedDiskSha256 || !isWritingSourcePath(path)) return [];
      const snapshot = captureWritingEditor(session.state, `${manuscriptId}:${path}`);
      return [{ path, expectedDiskSha256, sessionId: snapshot.sessionId, revision: snapshot.revision, text: snapshot.text }];
    });
  }

  private key(identity: WritingDocumentIdentity): string {
    return JSON.stringify([identity.manuscriptId, parseManuscriptPath(identity.relativePath)]);
  }
}
