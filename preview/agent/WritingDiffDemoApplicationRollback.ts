import type { AgentApplicationFile, AgentApplicationState, AgentEditorRestoration, AgentEditorRestorationRequest,
  AgentWorkspaceBuffer, AgentWorkspaceCheckpointVersion } from "@research-assistant/core/agent";
import type { WritingCheckpointRecord } from "@research-assistant/writing";
import type { DemoChange } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import type { WritingDiffDemoStorage } from "./WritingDiffDemoStorage";
import type { WritingDiffDemoRestorationStorage } from "./WritingDiffDemoRestorationStorage";
import { writingDiffDemoHash } from "./WritingDiffDemoStorage";
import { writingDiffDemoBytes, writingDiffDemoText } from "./WritingDiffDemoBytes";

interface Entry {
  application: AgentApplicationState | null;
  readonly admission: {readonly scope: {readonly requestId: string}};
  readonly texts: readonly DemoChange[];
  readonly diskSources: ReadonlyMap<string, string>;
}
/** Native preflight mock only; production leases and editor transactions own mutations. */
export class WritingDiffDemoApplicationRollback {
  constructor(private readonly disk: WritingDiffDemoStorage["files"], private readonly checkpoints: WritingDiffDemoStorage["checkpoints"],
    private readonly restorations: WritingDiffDemoRestorationStorage) {}
  private state(entry: Entry): AgentApplicationState {
    if (!entry.application) throw new Error("模拟原应用日志不存在");
    return entry.application;
  }
  private change(entry: Entry, path: string): DemoChange {
    const change = entry.texts.find(change => change.path === path);
    if (!change) throw new Error("模拟原应用冻结清单不匹配");
    return change;
  }
  private async checkedRecords(entry: Entry, buffers: readonly AgentWorkspaceBuffer[], versions: readonly AgentWorkspaceCheckpointVersion[]) {
    const records = await this.checkpoints.list(this.state(entry).scope.manuscriptId);
    for (const version of versions) {
      const buffer = buffers.find(buffer => buffer.path === version.path), record = records.find(record => record.checkpoint.relativePath === version.path);
      if (!buffer || !record || record.revision !== version.revision || record.checkpoint.version !== version.stateVersion
        || record.checkpoint.content !== buffer.text || record.checkpoint.savedSha256 !== buffer.expectedDiskSha256 || record.checkpoint.saveIntent !== null)
        throw new Error("模拟原应用补偿检查点版本冲突");
    }
    return records;
  }
  private async checkpointOwner(entry: Entry, file: AgentApplicationFile, buffer: AgentWorkspaceBuffer,
    versions: readonly AgentWorkspaceCheckpointVersion[], records: readonly WritingCheckpointRecord[], intent: AgentEditorRestoration | null) {
    const checkpoint = versions.some(version => version.path === file.path)
      ? records.find(record => record.checkpoint.relativePath === file.path)?.checkpoint : undefined;
    if (!checkpoint || file.target.kind !== "editor") throw new Error("模拟原应用补偿缺少可靠检查点");
    if (file.phase === "pending") return;
    const scope = this.state(entry).scope, change = this.change(entry, file.path);
    const sourceMatches = (id: string, hash: string) => checkpoint.operations.some(source => source.operationId === id
      && source.conversationId === scope.conversationId && source.requestId === entry.admission.scope.requestId && source.resultSha256 === hash);
    if (!sourceMatches(scope.operationId, await writingDiffDemoHash(writingDiffDemoBytes(change, "after")))) throw new Error("模拟原应用来源不匹配");
    const restored = file.phase === "restored", receipt = checkpoint.editorReceipt;
    const operationId = restored ? intent?.id : scope.operationId;
    const owner = restored ? intent?.sessionId : file.target.sessionId;
    const revision = restored ? intent?.resultRevision : file.target.resultRevision;
    if (!operationId || !receipt || receipt.operationId !== operationId || receipt.sessionId !== owner || receipt.revision !== revision
      || receipt.text !== buffer.text || (restored && !sourceMatches(operationId, await writingDiffDemoHash(writingDiffDemoBytes(change, "before")))))
      throw new Error("模拟原应用补偿真实回执不匹配");
  }
  private async checkEditor(entry: Entry, file: AgentApplicationFile, buffer: AgentWorkspaceBuffer,
    versions: readonly AgentWorkspaceCheckpointVersion[], records: readonly WritingCheckpointRecord[], allowAcknowledged: boolean) {
    const state = this.state(entry), change = this.change(entry, file.path);
    if (file.target.kind !== "editor") throw new Error("模拟原应用补偿目标不匹配");
    const intent = this.restorations.readIntent(state.scope, file.path);
    const revision = file.phase === "pending" && !intent ? file.target.revision
      : file.phase === "acknowledged" && allowAcknowledged && !intent ? file.target.resultRevision
      : file.phase === "restored" ? intent?.resultRevision : null;
    const expected = writingDiffDemoBytes(change, file.phase === "acknowledged" ? "after" : "before");
    const disk = (await this.disk.listFiles(state.scope.manuscriptId)).find(disk => disk.relativePath === file.path);
    const savedResult = ["acknowledged", "restored"].includes(file.phase) && disk?.sha256 === await writingDiffDemoHash(writingDiffDemoBytes(change, "after"));
    if (!revision || buffer.text !== writingDiffDemoText(expected) || buffer.expectedDiskSha256 !== disk?.sha256
      || (disk?.sha256 !== entry.diskSources.get(file.path) && !savedResult)) throw new Error("模拟原应用补偿正文或磁盘冲突");
    const owner = intent?.sessionId ?? file.target.sessionId;
    if (buffer.sessionId === owner) {
      if (buffer.revision !== revision) throw new Error("模拟原应用补偿当前会话版本冲突");
    } else await this.checkpointOwner(entry, file, buffer, versions, records, intent);
  }
  async authorizeRebuilt(entry: Entry, request: Extract<AgentEditorRestorationRequest, {action: "prepare"}>) {
    const file = this.state(entry).files.find(file => file.path === request.current.path);
    const proof = request.checkpointVersion;
    const record = (await this.checkpoints.list(request.scope.manuscriptId)).find(record => record.checkpoint.relativePath === request.current.path);
    if (!file || !record || !proof) throw new Error("模拟原应用恢复缺少可靠检查点");
    const buffer = {...request.current, expectedDiskSha256: record.checkpoint.savedSha256};
    const records = await this.checkedRecords(entry, [buffer], [proof]);
    await this.checkpointOwner(entry, file, buffer, [proof], records, null);
    await this.checkEditor(entry, file, buffer, [proof], records, true);
  }
  async check(entry: Entry, buffers: readonly AgentWorkspaceBuffer[], versions: readonly AgentWorkspaceCheckpointVersion[], allowAcknowledged: boolean) {
    const state = this.state(entry);
    if (state.status === "rolledBack") return;
    if (!["prepared", "applying", "recoveryRequired"].includes(state.status) || state.files.length !== entry.texts.length
      || state.files.some(file => file.phase === "conflict")) throw new Error("模拟原应用状态不能回滚");
    const records = await this.checkedRecords(entry, buffers, versions), diskFiles = await this.disk.listFiles(state.scope.manuscriptId);
    for (const file of state.files) {
      const change = entry.texts.find(change => change.path === file.path), buffer = buffers.find(buffer => buffer.path === file.path);
      if (!change) throw new Error("模拟原应用冻结清单不匹配");
      if (file.target.kind === "editor") {
        if (!buffer || buffers.filter(buffer => buffer.path === file.path).length !== 1) throw new Error("模拟原应用缺少编辑器目标");
        await this.checkEditor(entry, file, buffer, versions, records, allowAcknowledged);
      } else {
        if (buffer) throw new Error("模拟原应用磁盘目标已有编辑器");
        const before = change.kind === "added" ? null : writingDiffDemoBytes(change, "before");
        const after = change.kind === "deleted" ? null : writingDiffDemoBytes(change, "after");
        if (file.phase === "pending" || file.phase === "restored") {
          const disk = diskFiles.find(disk => disk.relativePath === file.path);
          if (before === null ? !!disk : disk?.sha256 !== await writingDiffDemoHash(before)) throw new Error("模拟原应用补偿磁盘版本冲突");
        } else await this.disk.checkRestoration(state.scope.manuscriptId, file.path, before, after, state.scope.operationId);
      }
    }
    // Commit after every target and proof validates, matching native transaction admission.
    entry.application = {...state, status: state.files.every(file => file.phase === "pending" || file.phase === "restored") ? "rolledBack" : "recoveryRequired"};
  }
}
