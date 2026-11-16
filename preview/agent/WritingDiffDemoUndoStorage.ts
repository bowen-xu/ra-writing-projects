import { decodeAgentUndoResponse, type AgentApplicationScope, type AgentApplicationState,
  type AgentApplicationFile, type AgentPendingWritingUndoRequest, type AgentUndoRequest, type AgentWorkspaceBuffer, type AgentUndoCheckpointVersion, type AgentEditorRestoration } from "@research-assistant/core/agent";
import { createAgentPendingWritingUndoGateway, createAgentUndoGateway, createAgentUndoEditorRestorationGateway } from "@research-assistant/data/agent";
import type { AgentUndoEditorRestorationRequest } from "@research-assistant/core/agent";
import type { WritingDiffDemoStorage } from "./WritingDiffDemoStorage";
import type { DemoChange } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import { sameWritingDiffDemoBytes, writingDiffDemoBytes, writingDiffDemoText } from "./WritingDiffDemoBytes";
import { writingDiffDemoHash } from "./WritingDiffDemoStorage";
import { WritingDiffDemoRestorationStorage } from "./WritingDiffDemoRestorationStorage";

import { writingDiffDemoPendingSave } from "./WritingDiffDemoPendingSave";

interface Journal { readonly id: number; readonly original: AgentApplicationScope; readonly changes: readonly DemoChange[];
  readonly diskSources: ReadonlyMap<string, string>; state: AgentApplicationState }
const sameScope = (left: AgentApplicationScope, right: AgentApplicationScope) =>
  (["conversationId", "manuscriptId", "proposalId", "operationId"] as const).every(key => left[key] === right[key]);
function inverse(change: DemoChange): DemoChange {
  const { beforeBytes, afterBytes, ...text } = change;
  return { ...text, kind: change.kind === "added" ? "deleted" : change.kind === "deleted" ? "added" : "modified",
    before: change.after, after: change.before, ...(afterBytes ? { beforeBytes: afterBytes } : {}),
    ...(beforeBytes ? { afterBytes: beforeBytes } : {}), additions: change.deletions, deletions: change.additions };
}
/** Native journal/byte I/O mock only. The shared workspace controller executes
 * the editor transactions, owns exclusion, and saves the resulting files. */
export class WritingDiffDemoUndoStorage {
  snapshot() { return structuredClone({ journals: this.journals }); }
  restore(snapshot: ReturnType<WritingDiffDemoUndoStorage["snapshot"]>): void {
    this.journals.clear(); for (const entry of snapshot.journals) this.journals.set(entry[0], entry[1]);
  }

  private readonly journals = new Map<string, Journal>();
  readonly restorationStorage: WritingDiffDemoRestorationStorage;
  constructor(private readonly disk: WritingDiffDemoStorage["files"],
    private readonly checkpoints: WritingDiffDemoStorage["checkpoints"],
    private readonly readOriginal: (scope: AgentApplicationScope) => { application: AgentApplicationState | null; texts: readonly DemoChange[];
      readonly admission: { readonly scope: { readonly requestId: string } } }) {
    this.restorationStorage = new WritingDiffDemoRestorationStorage(disk, scope => {
      const entry = this.journals.get(scope.operationId);
      if (!entry || !sameScope(entry.state.scope, scope)) throw new Error("模拟撤销补偿身份不匹配");
      return { get application() { return entry.state; }, set application(value) {
        if (!value) throw new Error("模拟撤销补偿不能删除操作日志"); entry.state = value;
      }, texts: entry.changes.map(inverse) };
    }, ["applying", "recoveryRequired"], async request => {
      const entry = this.journals.get(request.scope.operationId)!;
      const file = entry.state.files.find(file => file.path === request.current.path)!;
      const record = (await this.checkpoints.list(request.scope.manuscriptId)).find(record => record.checkpoint.relativePath === request.current.path);
      if (!record || !request.checkpointVersion) throw new Error("模拟恢复缺少可靠检查点");
      const buffer = { ...request.current, expectedDiskSha256: record.checkpoint.savedSha256 };
      await this.checkpointOwner(entry, file, buffer, [request.checkpointVersion]);
      const disk = (await this.disk.listFiles(request.scope.manuscriptId)).find(file => file.relativePath === request.current.path);
      const change = entry.changes.find(change => change.path === request.current.path)!;
      if (disk?.sha256 !== buffer.expectedDiskSha256 || (disk?.sha256 !== await writingDiffDemoHash(writingDiffDemoBytes(change, "before")!)
        && disk?.sha256 !== await writingDiffDemoHash(writingDiffDemoBytes(change, "after")!))) throw new Error("模拟恢复磁盘版本冲突");
    });
  }
  restorations(original: AgentApplicationScope) {
    return createAgentUndoEditorRestorationGateway(async (_command, args) => {
      const { originalScope, request } = args.request as AgentUndoEditorRestorationRequest;
      const entry = this.journals.get(request.scope.operationId);
      if (!entry || !sameScope(entry.original, originalScope)) throw new Error("模拟原应用与撤销身份不匹配");
      return { originalScope, result: await this.restorationStorage.gateway.execute(request) };
    }, original);
  }
  recoverOnStartup(): void {
    for (const entry of this.journals.values()) if (entry.state.status === "applying") entry.state = { ...entry.state, status: "recoveryRequired" };
  }
  readonly discovery = createAgentPendingWritingUndoGateway(async (_command, args) => {
    const request = args.request as AgentPendingWritingUndoRequest;
    const entries: Journal[] = [];
    for (const entry of this.journals.values()) {
      if (entry.original.manuscriptId !== request.manuscriptId || entry.id <= (request.after ?? 0)) continue;
      if (["prepared", "applying", "recoveryRequired"].includes(entry.state.status) || await this.pendingSave(entry)) entries.push(entry);
      if (entries.length > request.limit) break;
    }
    const items = entries.slice(0, request.limit).map(entry => ({ id: entry.id, undo: this.response(entry) }));
    return { schemaVersion: 1, manuscriptId: request.manuscriptId, items,
      nextCursor: entries.length > request.limit ? items.at(-1)!.id : null };
  });
  private async pendingSave(entry: Journal): Promise<boolean> {
    const original = this.readOriginal(entry.original);
    return writingDiffDemoPendingSave(entry.state, entry.original, original.admission.scope.requestId,
      entry.changes.map(inverse), this.checkpoints, this.restorationStorage);
  }
  readonly gateway = createAgentUndoGateway(async (command, args) => {
    if (command === "agent_find_writing_proposal_undo") {
      const scope = args.scope as AgentApplicationScope;
      const entry = [...this.journals.values()].find(item => sameScope(item.original, scope));
      return entry ? this.response(entry) : null;
    }
    return this.execute(args.request as AgentUndoRequest);
  });
  private response(entry: Journal) {
    return decodeAgentUndoResponse({ schemaVersion: 1, originalScope: entry.original, undoId: entry.state.scope.operationId, result: structuredClone(entry.state) });
  }
  private async targets(scope: AgentApplicationScope, changes: readonly DemoChange[], buffers: readonly AgentWorkspaceBuffer[]): Promise<readonly AgentApplicationFile[]> {
    const diskFiles = await this.disk.listFiles(scope.manuscriptId);
    return Promise.all(changes.map(async change => {
      const buffer = buffers.find(item => item.path === change.path), file = diskFiles.find(item => item.relativePath === change.path);
      const after = change.kind === "deleted" ? null : writingDiffDemoBytes(change, "after");
      if (after === null ? !!file : file?.sha256 !== await writingDiffDemoHash(after)) throw new Error("模拟撤销磁盘版本冲突");
      if (!buffer) return { path: change.path, phase: "pending", target: { kind: "disk" } };
      if (change.kind !== "modified" || after === null || buffer.text !== writingDiffDemoText(after) || buffer.expectedDiskSha256 !== file?.sha256) throw new Error("模拟撤销编辑版本冲突");
      return { path: change.path, phase: "pending", target: { kind: "editor", sessionId: buffer.sessionId, revision: buffer.revision, resultRevision: null } };
    }));
  }
  private async pendingTargets(entry: Journal, buffers: readonly AgentWorkspaceBuffer[]) {
    if (!entry.state.files.length || entry.state.files.some(file => file.phase !== "pending")) throw new Error("模拟撤销已派发，不能改变目标");
    const targets = await this.targets(entry.original, entry.changes, buffers);
    const disk = await this.disk.listFiles(entry.original.manuscriptId);
    for (const file of entry.state.files) {
      const next = targets.find(target => target.path === file.path);
      if (!next || next.target.kind !== file.target.kind || entry.diskSources.get(file.path) !== disk.find(item => item.relativePath === file.path)?.sha256
        || (file.target.kind === "editor" && next.target.kind === "editor" && file.target.sessionId === next.target.sessionId
          && file.target.revision !== next.target.revision)) throw new Error("模拟撤销冻结版本冲突");
    }
    return targets;
  }
  /** Same checkpoint/receipt admission as native; only Pending targets may renew. */
  private async resumedTargets(entry: Journal, buffers: readonly AgentWorkspaceBuffer[], versions: readonly AgentUndoCheckpointVersion[]) {
    const records = await this.checkpoints.list(entry.original.manuscriptId);
    for (const version of versions) {
      const buffer = buffers.find(buffer => buffer.path === version.path), record = records.find(record => record.checkpoint.relativePath === version.path);
      if (!buffer || !record || record.revision !== version.revision || record.checkpoint.version !== version.stateVersion
        || record.checkpoint.content !== buffer.text || record.checkpoint.savedSha256 !== buffer.expectedDiskSha256
        || record.checkpoint.saveIntent !== null) throw new Error("模拟撤销检查点版本冲突");
    }
    if (entry.state.files.every(file => file.phase === "pending")) return this.pendingTargets(entry, buffers);
    const diskFiles = await this.disk.listFiles(entry.original.manuscriptId), original = this.readOriginal(entry.original);
    return Promise.all(entry.state.files.map(async file => {
      const change = entry.changes.find(item => item.path === file.path)!;
      const expected = file.phase === "pending" ? change.kind === "deleted" ? null : writingDiffDemoBytes(change, "after")
        : change.kind === "added" ? null : writingDiffDemoBytes(change, "before");
      const disk = diskFiles.find(item => item.relativePath === file.path), buffer = buffers.find(item => item.path === file.path);
      if (file.target.kind === "disk") {
        if (buffer || (expected === null ? !!disk : disk?.sha256 !== await writingDiffDemoHash(expected))) throw new Error("模拟撤销续跑磁盘冲突");
        return file;
      }
      const revision = file.phase === "pending" ? file.target.revision : file.target.resultRevision;
      if (!buffer || !revision || expected === null || buffer.text !== writingDiffDemoText(expected) || buffer.expectedDiskSha256 !== disk?.sha256
        || (file.phase === "pending" && entry.diskSources.get(file.path) !== disk?.sha256)) throw new Error("模拟撤销续跑编辑器冲突");
      if (buffer.sessionId === file.target.sessionId) {
        if (buffer.revision !== revision) throw new Error("模拟撤销当前会话版本冲突");
      } else {
        const checkpoint = versions.some(version => version.path === file.path) ? records.find(record => record.checkpoint.relativePath === file.path)?.checkpoint : undefined;
        const sourceMatches = (id: string, hash: string) => checkpoint?.operations.some(source => source.operationId === id && source.resultSha256 === hash
          && source.conversationId === entry.original.conversationId && source.requestId === original.admission.scope.requestId);
        if (!checkpoint || !sourceMatches(entry.original.operationId, await writingDiffDemoHash(writingDiffDemoBytes(change, "after")!))) throw new Error("模拟撤销缺少原文件来源");
        if (file.phase === "acknowledged") {
          const receipt = checkpoint.editorReceipt;
          if (!receipt || receipt.operationId !== entry.state.scope.operationId || receipt.sessionId !== file.target.sessionId
            || receipt.revision !== revision || receipt.text !== buffer.text
            || !sourceMatches(entry.state.scope.operationId, await writingDiffDemoHash(expected))) throw new Error("模拟撤销原回执冲突");
        }
      }
      return file.phase === "pending" ? { ...file, target: { ...file.target, sessionId: buffer.sessionId, revision: buffer.revision } } : file;
    }));
  }
  /** Reliable CAS and historical receipt authorize a fresh compensation owner. */
  private async checkpointOwner(entry: Journal, file: AgentApplicationFile, buffer: AgentWorkspaceBuffer,
    versions: readonly AgentUndoCheckpointVersion[], intent?: AgentEditorRestoration) {
    const record = (await this.checkpoints.list(entry.original.manuscriptId)).find(record => record.checkpoint.relativePath === file.path);
    const proof = versions.find(proof => proof.path === file.path), checkpoint = record?.checkpoint;
    const original = this.readOriginal(entry.original), change = entry.changes.find(change => change.path === file.path)!;
    if (!proof || !record || !checkpoint || record.revision !== proof.revision || checkpoint.version !== proof.stateVersion
      || checkpoint.content !== buffer.text || checkpoint.savedSha256 !== buffer.expectedDiskSha256 || checkpoint.saveIntent !== null)
      throw new Error("模拟补偿检查点冲突");
    const sourceMatches = (id: string, hash: string) => checkpoint.operations.some(source => source.operationId === id
      && source.resultSha256 === hash && source.conversationId === entry.original.conversationId && source.requestId === original.admission.scope.requestId);
    if (!sourceMatches(entry.original.operationId, await writingDiffDemoHash(writingDiffDemoBytes(change, "after")!))) throw new Error("模拟补偿原来源冲突");
    if (file.target.kind !== "editor") throw new Error("模拟补偿目标不符");
    if (file.phase === "pending") return;
    const restored = file.phase === "restored", receipt = checkpoint.editorReceipt;
    const id = restored ? intent?.id : entry.state.scope.operationId;
    const owner = restored ? intent?.sessionId : file.target.sessionId;
    const revision = restored ? intent?.resultRevision : file.target.resultRevision;
    const hash = await writingDiffDemoHash(writingDiffDemoBytes(change, restored ? "after" : "before")!);
    if (!id || !receipt || receipt.operationId !== id || receipt.sessionId !== owner || receipt.revision !== revision
      || receipt.text !== buffer.text || !sourceMatches(id, hash)) throw new Error("模拟补偿原回执冲突");
  }
  /** Mock the native complete-plan preflight before any editor compensation.
   * Never infer a missing receipt from current bytes or accept an open disk target. */
  private async checkRollback(entry: Journal, buffers: readonly AgentWorkspaceBuffer[], allowEditors: boolean, versions: readonly AgentUndoCheckpointVersion[]) {
    const state = entry.state;
    if (state.status === "rolledBack") return;
    if (!["applying", "recoveryRequired"].includes(state.status)) throw new Error("模拟撤销状态不能回滚");
    const diskFiles = await this.disk.listFiles(state.scope.manuscriptId);
    for (const file of state.files) {
      const change = entry.changes.find(item => item.path === file.path)!;
      const source = change.kind === "deleted" ? null : writingDiffDemoBytes(change, "after");
      const result = change.kind === "added" ? null : writingDiffDemoBytes(change, "before");
      const buffer = buffers.find(item => item.path === file.path), disk = diskFiles.find(item => item.relativePath === file.path);
      if (file.phase === "conflict") throw new Error("模拟撤销目标冲突");
      if (file.target.kind === "editor") {
        const intent = this.restorationStorage.readIntent(state.scope, file.path);
        const revision = file.phase === "pending" && !intent ? file.target.revision
          : file.phase === "acknowledged" && allowEditors && !intent ? file.target.resultRevision
          : file.phase === "restored" ? intent?.resultRevision : null;
        const expected = file.phase === "acknowledged" ? result : source;
        const savedInverse = (file.phase === "acknowledged" || file.phase === "restored")
          && result !== null && disk?.sha256 === await writingDiffDemoHash(result);
        if (!buffer || buffers.filter(item => item.path === file.path).length !== 1 || !revision || expected === null
          || buffer.text !== writingDiffDemoText(expected)
          || buffer.expectedDiskSha256 !== disk?.sha256 || (entry.diskSources.get(file.path) !== disk?.sha256 && !savedInverse)
          ) throw new Error("模拟撤销补偿编辑器版本冲突");
        const owner = intent?.sessionId ?? file.target.sessionId;
        if (buffer.sessionId === owner) {
          if (buffer.revision !== revision) throw new Error("模拟补偿当前会话版本冲突");
        } else await this.checkpointOwner(entry, file, buffer, versions, intent ?? undefined);
      } else {
        if (buffer) throw new Error("模拟撤销磁盘目标已有编辑器");
        if (file.phase === "pending" || file.phase === "restored") {
          if (source === null ? !!disk : disk?.sha256 !== await writingDiffDemoHash(source)) throw new Error("模拟撤销补偿磁盘版本冲突");
        } else await this.disk.checkRestoration(state.scope.manuscriptId, file.path, source, result, state.scope.operationId);
      }
    }
    entry.state = { ...state, status: state.files.every(file => file.phase === "pending" || file.phase === "restored") ? "rolledBack" : "recoveryRequired" };
  }
  private async execute(request: AgentUndoRequest) {
    let entry = this.journals.get(request.undoId);
    const { scope, undoId, command } = request;
    if (entry && !sameScope(entry.original, scope)) throw new Error("模拟撤销身份冲突");
    if (command.action === "read" && !entry) return { schemaVersion: 1, originalScope: scope, undoId, result: null };
    if (command.action === "prepare" && !entry) {
      const original = this.readOriginal(scope);
      if (original.application?.status !== "applied" || !sameScope(original.application.scope, scope)) throw new Error("模拟原应用尚未确认");
      const files = await this.targets(scope, original.texts, command.buffers);
      const diskSources = new Map((await this.disk.listFiles(scope.manuscriptId)).map(file => [file.relativePath, file.sha256]));
      entry = { id: this.journals.size + 1, original: structuredClone(scope), changes: structuredClone(original.texts), diskSources, state: {
        kind: "state", schemaVersion: 1, scope: { ...scope, operationId: undoId }, status: "prepared", files } };
      this.journals.set(undoId, entry);
    }
    if (!entry) throw new Error("模拟撤销未准备");
    const state = entry.state;
    if (command.action === "read" || command.action === "prepare") return this.response(entry);
    if (command.action === "prepareRollback" || command.action === "rollbackDisk") {
      await this.checkRollback(entry, command.buffers, command.action === "prepareRollback", command.checkpointVersions ?? []);
      if (command.action === "rollbackDisk") await this.restorationStorage.rollback(state.scope, true);
      return this.response(entry);
    }
    if (command.action === "cancelPending") {
      if (state.status !== "rolledBack") {
        if (!["prepared", "applying", "recoveryRequired"].includes(state.status) || state.files.some(file => file.phase !== "pending")) throw new Error("模拟撤销已经派发，不能取消");
        entry.state = { ...state, status: "rolledBack" };
      }
      return this.response(entry);
    }
    if (command.action !== "defer" && this.restorationStorage.hasIntent(state.scope)) throw new Error("模拟撤销补偿已开始，不能继续正向撤销");
    if (command.action === "start") {
      if (state.status !== "prepared") throw new Error("模拟撤销冻结版本冲突");
      entry.state = { ...state, files: await this.pendingTargets(entry, command.buffers), status: "applying" }; return this.response(entry);
    }
    if (command.action === "resume") {
      if (state.status !== "recoveryRequired" || !state.files.some(file => file.phase === "pending")
        || state.files.some(file => file.phase !== "pending" && file.phase !== "acknowledged")) throw new Error("模拟撤销必须先核对派发结果");
      entry.state = { ...state, files: await this.resumedTargets(entry, command.buffers, command.checkpointVersions ?? []), status: "applying" }; return this.response(entry);
    }
    if (command.action === "defer") {
      if (state.status === "applying") entry.state = { ...state, status: "recoveryRequired" };
      return this.response(entry);
    }
    const path = "path" in command ? command.path : "current" in command ? command.current.path : "actual" in command ? command.actual.path : null;
    const file = state.files.find(item => item.path === path), change = entry.changes.find(item => item.path === path);
    if (!file || !change) throw new Error("模拟撤销目标不可用");
    const before = change.kind === "deleted" ? null : writingDiffDemoBytes(change, "after");
    const after = change.kind === "added" ? null : writingDiffDemoBytes(change, "before");
    const acknowledge = (revision?: string) => {
      const files = entry.state.files.map(item => item.path === path ? { ...item, phase: "acknowledged" as const,
        target: item.target.kind === "editor" ? { ...item.target, resultRevision: revision ?? null } : item.target } : item);
      entry.state = { ...entry.state, files, status: files.every(item => item.phase === "acknowledged") ? "applied"
        : entry.state.status === "recoveryRequired" ? "recoveryRequired" : "applying" };
    };
    if (command.action === "prepareEditor" && file.target.kind === "editor") {
      if (state.status !== "applying" || file.phase !== "pending" || command.current.sessionId !== file.target.sessionId
        || command.current.revision !== file.target.revision || before === null || command.current.text !== writingDiffDemoText(before)) throw new Error("模拟撤销当前编辑版本冲突");
      const text = after === null ? null : writingDiffDemoText(after);
      if (text === null) throw new Error("模拟撤销不是文本");
      entry.state = { ...state, files: state.files.map(item => item === file ? { ...item, phase: "dispatched" } : item) };
      return decodeAgentUndoResponse({ schemaVersion: 1, originalScope: scope, undoId,
        result: { kind: "edit", schemaVersion: 1, scope: state.scope, expected: command.current, text } });
    }
    if (command.action === "confirmEditor" && file.target.kind === "editor") {
      if (!["dispatched", "acknowledged"].includes(file.phase) || command.actual.sessionId !== file.target.sessionId
        || after === null || command.actual.text !== writingDiffDemoText(after)
        || (file.phase === "acknowledged" && command.actual.revision !== file.target.resultRevision)) throw new Error("模拟撤销回执冲突");
      acknowledge(command.actual.revision); return this.response(entry);
    }
    if (["applyDisk", "reconcileDisk"].includes(command.action) && file.target.kind === "disk") {
      if (file.phase === "acknowledged") return this.response(entry);
      if (command.action === "applyDisk" && file.phase === "pending" && state.status === "applying") {
        entry.state = { ...state, files: state.files.map(item => item === file ? { ...item, phase: "dispatched" } : item) };
        await this.disk.applyChange(scope.manuscriptId, file.path, before, after, undoId);
      } else if (file.phase !== "dispatched") throw new Error("模拟撤销未派发");
      const present = (await this.disk.listFiles(scope.manuscriptId)).some(item => item.relativePath === file.path);
      if (!sameWritingDiffDemoBytes(present ? await this.disk.readBytes(scope.manuscriptId, file.path) : null, after)
        || (before !== null && !sameWritingDiffDemoBytes(await this.disk.readPreserved(scope.manuscriptId, file.path, undoId), before))) throw new Error("模拟撤销磁盘结果未确认");
      acknowledge(); return this.response(entry);
    }
    throw new Error("模拟存储尚不支持此撤销恢复命令");
  }
}
