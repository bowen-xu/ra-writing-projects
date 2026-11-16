import {
  decodeAgentProposalReview, decodeAgentWorkspaceReview, decodeAgentWorkspaceHistory, decodeAgentWorkspaceFileReview,
  type AgentApplicationRequest, type AgentApplicationScope, type AgentApplicationState, type AgentApplicationFile,
  type AgentPendingWritingApplicationRequest, type AgentWorkspaceScope, type AgentWorkspaceReview, type AgentWorkspaceFileReview, type AgentWorkspaceBuffer,
} from "@research-assistant/core/agent";
import type { AgentWorkspaceReviewGateway } from "@research-assistant/data/agent";
import { createAgentApplicationGateway, createAgentPendingWritingApplicationGateway } from "@research-assistant/data/agent";
import type { WritingFileApplicationGateways } from "../../../../../src/features/writing/agent/useWritingFileApplications";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-preview/writing-submission-controller";
import type { WritingDiffDemoStorage } from "../../../../agent/WritingDiffDemoStorage";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
import type { DemoChange } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import { isWritingSourcePath } from "@research-assistant/writing";
import { WritingDiffDemoHistory } from "@research-assistant/workbench-preview/writing-diff-demo-history";
import { WritingDemoDeliveryTools } from "@research-assistant/workbench-preview/writing-demo-delivery-tools";
import { WritingDiffDemoUndoStorage } from "../../../../agent/WritingDiffDemoUndoStorage";
import { WritingDiffDemoRestorationStorage } from "../../../../agent/WritingDiffDemoRestorationStorage";
import { WritingDiffDemoApplicationRollback } from "../../../../agent/WritingDiffDemoApplicationRollback";
import { sameWritingDiffDemoBytes, writingDiffDemoBytes, writingDiffDemoContent, writingDiffDemoText } from "../../../../agent/WritingDiffDemoBytes";

import { writingDiffDemoPendingSave } from "../../../../agent/WritingDiffDemoPendingSave";

interface Completion {
  readonly id: number;
  readonly createdAt: string;
  readonly admission: WritingSubmissionAdmission;
  readonly review: AgentWorkspaceReview;
  readonly texts: readonly DemoChange[];
  readonly diskSources: ReadonlyMap<string, string>;
  proposalId: string | null;
  application: AgentApplicationState | null;
  applicationId: number | null;
  acknowledged: boolean;
  rejected?: boolean;
}
const identity = (scope: AgentWorkspaceScope) => JSON.stringify([scope.manuscriptId, scope.conversationId, scope.requestId, scope.contextSnapshotId]);
const unsupported = async (): Promise<never> => { throw new Error("模拟 Agent 存储尚不支持此原生恢复操作"); };

/** Mock native I/O, independent of editor instances and chat selection. The
 * production receiver, application coordinator and editor delivery own all edits.
 * Frozen texts/journals survive simulated host reconstruction; returned records
 * are snapshots, never a second mutable source for current editor text.
 */
export class WritingDiffDemoAgentStorage {
  readonly tools = new WritingDemoDeliveryTools(async admission => (await this.reviews.review(admission.scope)).binding);
  snapshot() { return structuredClone({ completions: this.completions, nextCompletionId: this.nextCompletionId, nextApplicationId: this.nextApplicationId }); }
  restore(snapshot: ReturnType<WritingDiffDemoAgentStorage["snapshot"]>): void {
    this.completions.clear(); for (const entry of snapshot.completions) this.completions.set(entry[0], entry[1]);
    this.nextCompletionId = snapshot.nextCompletionId;
    this.nextApplicationId = snapshot.nextApplicationId;
  }

  readonly history = new WritingDiffDemoHistory();
  private readonly completions = new Map<string, Completion>();
  private tail: Promise<unknown> = Promise.resolve();
  private nextCompletionId = 1;
  private nextApplicationId = 1;
  readonly undoStorage: WritingDiffDemoUndoStorage;
  readonly restorationStorage: WritingDiffDemoRestorationStorage;
  private readonly rollbackAdmission: WritingDiffDemoApplicationRollback;
  loseAcknowledgmentOnce = false;
  failBeforeDispatch = false;
  failEditorConfirmation = false;
  failDiskConfirmation = false;
  readonly initialized: Promise<void>;
  private readonly disk: WritingDiffDemoStorage["files"];
  private readonly checkpoints: WritingDiffDemoStorage["checkpoints"];
  constructor(storage: Pick<WritingDiffDemoStorage, "files" | "checkpoints">, initial: {
    readonly admission: WritingSubmissionAdmission; readonly changes: readonly DemoChange[];
  } | undefined) { this.disk = storage.files; this.checkpoints = storage.checkpoints;
    this.undoStorage = new WritingDiffDemoUndoStorage(this.disk, storage.checkpoints, scope => this.fromProposal(scope));
    this.restorationStorage = new WritingDiffDemoRestorationStorage(this.disk, scope => this.fromProposal(scope), undefined,
      request => this.rollbackAdmission.authorizeRebuilt(this.fromProposal(request.scope), request));
    this.rollbackAdmission = new WritingDiffDemoApplicationRollback(this.disk, storage.checkpoints, this.restorationStorage);
    this.initialized = initial ? this.complete(initial.admission, initial.changes) : Promise.resolve(); }

  complete(value: WritingSubmissionAdmission, changes: readonly DemoChange[], outcome: "completed" | "failed" | "canceled" = "completed",
    sourceBuffers: readonly AgentWorkspaceBuffer[] = [], reported = false, deferFinish = false): Promise<void> {
    const admission = structuredClone(value), texts = structuredClone(changes);
    const sources = structuredClone(sourceBuffers);
    // A failed completion is reported to its caller, but cannot prevent a later
    // independent turn from reaching storage. Reads still await the latest write.
    const operation = this.tail.then(() => undefined, () => undefined).then(async () => {
      this.history.assertAvailable(admission.scope.conversationId);
      const key = identity(admission.scope), existing = this.completions.get(key);
      if (existing) {
        if (outcome !== "completed") { this.history.finish(admission, outcome); return; }
        if (JSON.stringify(existing.admission) !== JSON.stringify(admission) || JSON.stringify(existing.texts) !== JSON.stringify(texts)) throw new Error("模拟完成通知身份冲突");
        if (sources.some(buffer => existing.diskSources.get(buffer.path) !== buffer.expectedDiskSha256)) throw new Error("模拟冻结来源冲突");
        return;
      }
      const diskSources = new Map<string, string>();
      for (const change of texts) {
        if (change.kind === "added") continue;
        const frozen = sources.find(buffer => buffer.path === change.path);
        diskSources.set(change.path, frozen?.expectedDiskSha256 ?? await writingDiffDemoHash(await this.disk.readBytes(admission.scope.manuscriptId, change.path)));
      }
      const metadata = await Promise.all(texts.map(async (change) => ({ path: change.path, kind: change.kind,
        hasEditorBuffer: change.kind === "modified" && ((isWritingSourcePath(change.path)
          && writingDiffDemoText(writingDiffDemoBytes(change, "before")) !== null) || sources.some(buffer => buffer.path === change.path)),
        before: change.kind === "added" ? null : { sha256: await writingDiffDemoHash(writingDiffDemoBytes(change, "before")), byteSize: writingDiffDemoBytes(change, "before").byteLength, executable: false },
        after: change.kind === "deleted" ? null : { sha256: await writingDiffDemoHash(writingDiffDemoBytes(change, "after")), byteSize: writingDiffDemoBytes(change, "after").byteLength, executable: false },
      })));
      const review = decodeAgentWorkspaceReview({ schemaVersion: 1, binding: { ...admission,
        leaseId: crypto.randomUUID(), manifestHash: await writingDiffDemoHash(JSON.stringify(metadata)) }, changes: metadata });
      if (!deferFinish) {
        if (outcome === "completed") this.history.complete(admission, texts, reported);
        else this.history.finish(admission, outcome);
      }
      this.completions.set(key, { id: this.nextCompletionId++, createdAt: new Date().toISOString(), admission, review, texts, diskSources,
        proposalId: null, application: null, applicationId: null, acknowledged: false });
    });
    this.tail = operation;
    return operation;
  }
  /** Mock the native startup journal scan, retaining every phase and receipt.
   * Production resume/reconciliation controllers decide what may happen next. */
  recoverOnStartup(): void {
    this.undoStorage.recoverOnStartup();
    for (const entry of this.completions.values()) {
      if (entry.application?.status === "applying") entry.application = { ...entry.application, status: "recoveryRequired" };
    }
  }
  hasExecutionWorkspace(conversationId: string): boolean {
    return !this.history.isDeleted(conversationId) && [...this.completions.values()]
      .some(entry => entry.admission.scope.conversationId === conversationId);
  }
  async deleteConversation(conversationId: string, expectedWatermark: number, validate: () => void = () => undefined,
    publish: (mutation: () => void) => void = mutation => mutation()): Promise<void> {
    await this.tail;
    validate();
    publish(() => this.deleteConversationReady(conversationId, expectedWatermark));
  }
  async waitForDeletion(): Promise<void> { await this.tail; }
  deleteConversationReady(conversationId: string, expectedWatermark: number): void {
    this.history.deleteConversation(conversationId, expectedWatermark);
    // Admitted file journals remain owned by the workspace.
    for (const [key, entry] of this.completions) {
      if (entry.admission.scope.conversationId === conversationId && !entry.application) this.completions.delete(key);
    }
  }
  private fromScope(scope: AgentWorkspaceScope): Completion {
    const entry = this.completions.get(identity(scope));
    if (!entry) throw new Error("模拟完成记录不存在");
    return entry;
  }
  private fromProposal(scope: Pick<AgentApplicationScope, "manuscriptId" | "conversationId" | "proposalId">): Completion {
    const entry = [...this.completions.values()].find((item) => item.proposalId === scope.proposalId
      && item.admission.scope.manuscriptId === scope.manuscriptId && item.admission.scope.conversationId === scope.conversationId);
    if (!entry) throw new Error("模拟冻结提案不存在");
    return entry;
  }
  private proposal(entry: Completion) {
    if (!entry.proposalId) throw new Error("模拟冻结提案尚未保存");
    return decodeAgentProposalReview({ schemaVersion: 1, proposalId: entry.proposalId,
      status: entry.rejected ? "rejected" : entry.application?.status === "recoveryRequired" ? "recovery_required"
        : entry.application?.status === "rolledBack" ? "undone"
        : entry.application?.status === "prepared" ? "applying" : entry.application?.status ?? "pending", review: entry.review });
  }
  private file(entry: Completion, path: string): AgentWorkspaceFileReview {
    const change = entry.review.changes.find((item) => item.path === path), text = entry.texts.find((item) => item.path === path);
    if (!change || !text) throw new Error("模拟冻结文件不存在");
    return decodeAgentWorkspaceFileReview({ schemaVersion: 1, binding: entry.review.binding, change,
      before: change.before ? writingDiffDemoContent(writingDiffDemoBytes(text, "before")) : null,
      after: change.after ? writingDiffDemoContent(writingDiffDemoBytes(text, "after")) : null });
  }
  readonly reviews: AgentWorkspaceReviewGateway = {
    list: async (request) => {
      await this.tail; this.history.assertAvailable(request.conversationId);
      const all = [...this.completions.values()].filter(({ admission }) => admission.scope.manuscriptId === request.manuscriptId
        && admission.scope.conversationId === request.conversationId).sort((left, right) =>
        left.createdAt === right.createdAt ? (left.admission.scope.requestId < right.admission.scope.requestId ? 1 : -1)
          : left.createdAt < right.createdAt ? 1 : -1);
      const offset = request.cursor === null ? 0 : all.findIndex(({ admission }) => admission.scope.requestId === request.cursor) + 1;
      if (request.cursor !== null && offset === 0) throw new Error("模拟历史分页身份不匹配");
      const entries = all.slice(offset, offset + request.limit).map(({ admission, createdAt }) => ({ ...admission, createdAt }));
      return decodeAgentWorkspaceHistory({ schemaVersion: 1, entries,
        nextCursor: offset + entries.length < all.length ? entries.at(-1)?.scope.requestId : null }, request);
    },
    review: async (scope) => { await this.tail; this.history.assertAvailable(scope.conversationId); return structuredClone(this.fromScope(scope).review); },
    reviewBinding: async (binding) => {
      await this.tail; this.history.assertAvailable(binding.scope.conversationId);
      const review = this.fromScope(binding.scope).review;
      if (JSON.stringify(review.binding) !== JSON.stringify(binding)) throw new Error("模拟工作区身份不匹配");
      return structuredClone(review);
    },
    readFile: async (request) => {
      await this.tail; this.history.assertAvailable(request.binding.scope.conversationId); const entry = this.fromScope(request.binding.scope), file = this.file(entry, request.path);
      if (JSON.stringify(request.binding) !== JSON.stringify(entry.review.binding)
        || JSON.stringify(request.before) !== JSON.stringify(file.change.before)
        || JSON.stringify(request.after) !== JSON.stringify(file.change.after)) throw new Error("模拟历史文件版本冲突");
      return file;
    },
  };
  private readonly applicationDiscovery = createAgentPendingWritingApplicationGateway(async (_command, args) => {
    await this.tail;
    const request = args.request as AgentPendingWritingApplicationRequest;
    const entries = [...this.completions.values()].filter(entry => entry.application && entry.applicationId !== null
      && entry.admission.scope.manuscriptId === request.manuscriptId && entry.applicationId > (request.after ?? 0))
      .sort((left, right) => left.applicationId! - right.applicationId!);
    const items = [];
    for (const entry of entries) {
      const state = entry.application!;
      if (["prepared", "applying", "recoveryRequired"].includes(state.status)
        || await writingDiffDemoPendingSave(state, state.scope, entry.admission.scope.requestId,
          entry.texts, this.checkpoints, this.restorationStorage)) items.push({ id: entry.applicationId, application: structuredClone(state) });
      if (items.length > request.limit) break;
    }
    const page = items.slice(0, request.limit);
    return { schemaVersion: 1, manuscriptId: request.manuscriptId, items: page,
      nextCursor: items.length > request.limit ? page.at(-1)!.id : null };
  });
  readonly gateways: WritingFileApplicationGateways = {
    pendingApplications: { list: request => this.applicationDiscovery.list(request) },
    pendingUndos: { list: request => this.undoStorage.discovery.list(request) },
    delivery: {
      tools: this.tools,
      sessions: {
        create: async (conversationId) => { await this.tail; return this.history.gateway.create(conversationId); },
        open: async (conversationId) => { await this.tail; return this.history.gateway.open(conversationId); },
        readHistory: async (request) => { await this.tail; return this.history.gateway.readHistory(request); },
        waitForHistory: (request, signal) => this.history.gateway.waitForHistory(request, signal),
      },
      proposals: {
        latest: async (scope) => { await this.tail; this.history.assertAvailable(scope.conversationId); const entry = this.fromScope(scope); return entry.proposalId ? this.proposal(entry) : null; },
        publish: async (review) => {
          this.history.assertAvailable(review.binding.scope.conversationId);
          const entry = this.fromScope(review.binding.scope);
          if (JSON.stringify(review) !== JSON.stringify(entry.review)) throw new Error("模拟提案冻结版本冲突");
          entry.proposalId ??= crypto.randomUUID(); return this.proposal(entry);
        },
        review: async (scope) => { const entry = this.fromProposal(scope); if (!entry.application) this.history.assertAvailable(scope.conversationId); return this.proposal(entry); },
        readFile: async (request) => { const entry = this.fromProposal(request.proposal); if (!entry.application) this.history.assertAvailable(request.proposal.conversationId); return { schemaVersion: 1, proposalId: request.proposal.proposalId,
          file: this.file(entry, request.path) }; },
        reject: async (request) => {
          await this.tail;
          this.history.assertAvailable(request.conversationId);
          const entry = this.fromProposal(request);
          if (entry.application) throw new Error("已准入的修改须通过原操作恢复或撤销");
          entry.rejected = true;
          return this.proposal(entry);
        },
      },
      reviews: this.reviews,
      deliveries: {
        list: async (request) => {
          await this.tail;
          const entries = [...this.completions.values()].filter((item) => !this.history.isDeleted(item.admission.scope.conversationId) && !item.acknowledged
            && item.admission.scope.manuscriptId === request.manuscriptId && item.id > (request.after ?? 0));
          const items = entries.slice(0, request.limit).map((entry) => ({ id: entry.id, ...structuredClone(entry.admission) }));
          return { schemaVersion: 1, manuscriptId: request.manuscriptId, items,
            nextCursor: entries.length > request.limit ? items.at(-1)!.id : null };
        },
        acknowledge: async (admission) => {
          const entry = this.fromScope(admission.scope);
          if (entry.admission.turnId !== admission.turnId || (!entry.rejected && entry.texts.length > 0
            && !["applied", "rolledBack"].includes(entry.application?.status ?? ""))) throw new Error("模拟文件修改尚未确认");
          entry.acknowledged = true;
          if (this.loseAcknowledgmentOnce) { this.loseAcknowledgmentOnce = false; throw new Error("模拟签收回执丢失"); }
        },
      },
    },
    application: {
      applications: createAgentApplicationGateway(async (command, args) => {
        if (command === "agent_find_writing_proposal_application") {
          const state = this.fromProposal(args.request as AgentApplicationScope).application;
          return state ? structuredClone(state) : null;
        }
        return this.execute(args.request as AgentApplicationRequest);
      }),
      restorations: { execute: request => this.restorationStorage.gateway.execute(request) }, undos: {
        find: scope => this.undoStorage.gateway.find(scope), execute: request => this.undoStorage.gateway.execute(request),
      },
      undoRestorations: scope => this.undoStorage.restorations(scope),
    },
  };
  private async checkedTargets(entry: Completion, buffers: readonly AgentWorkspaceBuffer[]): Promise<readonly AgentApplicationFile[]> {
    if (new Set(buffers.map(buffer => buffer.path)).size !== buffers.length) throw new Error("模拟文件缓冲重复");
    const captured = structuredClone(buffers);
    const diskFiles = await this.disk.listFiles(entry.admission.scope.manuscriptId);
    const files: AgentApplicationFile[] = [];
    for (const change of entry.texts) {
      const buffer = captured.find(item => item.path === change.path);
      const indexed = diskFiles.find(file => file.relativePath === change.path);
      if (change.kind === "added") {
        if (buffer || indexed) throw new Error("模拟新增文件已存在");
        files.push({ path: change.path, phase: "pending", target: { kind: "disk" } });
        continue;
      }
      const disk = await this.disk.readBytes(entry.admission.scope.manuscriptId, change.path);
      const diskHash = await writingDiffDemoHash(disk), before = writingDiffDemoBytes(change, "before");
      const sourceMatches = diskHash === entry.diskSources.get(change.path)
        || diskHash === await writingDiffDemoHash(before);
      if (!sourceMatches) throw new Error("模拟 Agent 文件版本已过期");
      if (!buffer) {
        if (!sameWritingDiffDemoBytes(disk, before)) throw new Error("模拟 Agent 文件版本已过期");
        files.push({ path: change.path, phase: "pending", target: { kind: "disk" } });
      } else {
        const after = writingDiffDemoBytes(change, "after"), source = writingDiffDemoText(before), result = writingDiffDemoText(after);
        if (change.kind !== "modified" || source === null || result === null || before.length > 4 * 1024 * 1024 || after.length > 4 * 1024 * 1024
          || buffer.text !== source || diskHash !== buffer.expectedDiskSha256) throw new Error("模拟 Agent 文件版本已过期");
        files.push({ path: change.path, phase: "pending", target: { kind: "editor", sessionId: buffer.sessionId, revision: buffer.revision, resultRevision: null } });
      }
    }
    return files;
  }
  private async execute(request: AgentApplicationRequest) {
    const entry = this.fromProposal(request.scope);
    if (request.action === "begin") {
      this.history.assertAvailable(request.scope.conversationId);
      if (entry.rejected) throw new Error("已放弃的修改不能再次应用");
      if (entry.application) return structuredClone(entry.application);
      const files = await this.checkedTargets(entry, request.buffers);
      entry.application = { kind: "state", schemaVersion: 1, scope: { ...request.scope }, status: "applying",
        files };
      entry.applicationId = this.nextApplicationId++;
    }
    const state = entry.application;
    if (!state || state.scope.operationId !== request.scope.operationId
      || state.scope.manuscriptId !== request.scope.manuscriptId || state.scope.conversationId !== request.scope.conversationId
      || state.scope.proposalId !== request.scope.proposalId) throw new Error("模拟应用操作身份不匹配");
    if (request.action === "read" || request.action === "begin") return structuredClone(state);
    if (request.action === "prepareRollback") {
      await this.rollbackAdmission.check(entry, request.buffers, request.checkpointVersions ?? [], true);
      return structuredClone(entry.application);
    }
    if (request.action === "rollbackDisk" || request.action === "rollbackRemainder") {
      if (request.action === "rollbackRemainder" && request.buffers) await this.rollbackAdmission.check(entry, request.buffers, request.checkpointVersions ?? [], false);
      return this.restorationStorage.rollback(request.scope, request.action === "rollbackRemainder");
    }
    if (this.restorationStorage.hasIntent(request.scope)) throw new Error("模拟补偿已开始，不能继续正向应用");
    if (request.action === "applyDisk" || request.action === "reconcileDisk") {
      const file = state.files.find(item => item.path === request.path), change = entry.texts.find(item => item.path === request.path);
      if (!file || !change || file.target.kind !== "disk") throw new Error("模拟磁盘目标不存在");
      if (file.phase === "acknowledged") return structuredClone(state);
      if (request.action === "applyDisk" && file.phase === "pending") {
        if (state.status !== "applying" || this.failBeforeDispatch) throw new Error("模拟派发日志尚未写入");
        entry.application = { ...state, files: state.files.map(item => item === file ? { ...item, phase: "dispatched" } : item) };
        try {
          await this.disk.applyChange(request.scope.manuscriptId, file.path, change.kind === "added" ? null : writingDiffDemoBytes(change, "before"),
            change.kind === "deleted" ? null : writingDiffDemoBytes(change, "after"), request.scope.operationId);
        } catch (reason) {
          entry.application = { ...entry.application, status: "recoveryRequired" }; throw reason;
        }
      } else if (file.phase !== "dispatched") throw new Error("模拟磁盘目标尚未派发");
      const current = entry.application!;
      const indexed = (await this.disk.listFiles(request.scope.manuscriptId)).find(item => item.relativePath === file.path);
      const matches = change.kind === "deleted" ? !indexed : indexed?.sha256 === await writingDiffDemoHash(writingDiffDemoBytes(change, "after"));
      const preserved = change.kind === "added" || sameWritingDiffDemoBytes(
        await this.disk.readPreserved(request.scope.manuscriptId, file.path, request.scope.operationId), writingDiffDemoBytes(change, "before"));
      const confirmationFailed = this.failDiskConfirmation && file === state.files.at(-1);
      if (!matches || !preserved || confirmationFailed) {
        entry.application = { ...current, status: "recoveryRequired" };
        if (confirmationFailed) throw new Error("模拟磁盘签收日志尚未写入");
        return structuredClone(entry.application);
      }
      const files = current.files.map(item => item.path === file.path ? { ...item, phase: "acknowledged" as const } : item);
      entry.application = { ...current, files, status: files.every(item => item.phase === "acknowledged") ? "applied" : "applying" };
      return structuredClone(entry.application);
    }
    if (request.action === "resume") {
      if (!["applying", "recoveryRequired"].includes(state.status) || state.files.some(file => file.phase !== "pending")) throw new Error("模拟应用必须核对原派发回执");
      const files = await this.checkedTargets(entry, request.buffers);
      if (state.status === "applying" && JSON.stringify(files) !== JSON.stringify(state.files)) throw new Error("模拟活动编辑器身份冲突");
      // Commit only after the entire plan validates; no partial rebinding.
      entry.application = { ...state, status: "applying", files }; return structuredClone(entry.application);
    }
    if (request.action === "deferEditor") {
      const file = state.files.find(item => item.path === request.path);
      if (!file || file.target.kind !== "editor") throw new Error("模拟编辑器目标不存在");
      if (file.phase === "acknowledged") return structuredClone(state);
      if (file.phase !== "dispatched") throw new Error("模拟未派发目标不能进入回执核对");
      entry.application = { ...state, status: "recoveryRequired" }; return structuredClone(entry.application);
    }
    if (request.action === "prepareEditor") {
      const file = state.files.find((item) => item.path === request.current.path), text = entry.texts.find((item) => item.path === request.current.path);
      if (!file || file.target.kind !== "editor" || file.phase !== "pending") return structuredClone(state);
      if (state.status !== "applying" || this.failBeforeDispatch) throw new Error("模拟派发日志尚未写入");
      const before = text ? writingDiffDemoText(writingDiffDemoBytes(text, "before")) : null;
      const after = text ? writingDiffDemoText(writingDiffDemoBytes(text, "after")) : null;
      if (after === null || request.current.sessionId !== file.target.sessionId || request.current.revision !== file.target.revision || request.current.text !== before) throw new Error("模拟编辑器版本冲突");
      entry.application = { ...state, files: state.files.map((item) => item === file ? { ...file, phase: "dispatched" } : item) };
      return { kind: "edit", schemaVersion: 1, scope: { ...request.scope }, expected: { ...request.current }, text: after };
    }
    if (request.action === "confirmEditor") {
      const file = state.files.find((item) => item.path === request.actual.path), text = entry.texts.find((item) => item.path === request.actual.path);
      if (!file || file.target.kind !== "editor" || !["dispatched", "acknowledged"].includes(file.phase)
        || file.target.sessionId !== request.actual.sessionId || request.actual.revision === file.target.revision
        || !text || request.actual.text !== writingDiffDemoText(writingDiffDemoBytes(text, "after"))) throw new Error("模拟应用回执不匹配");
      if (file.phase === "acknowledged") {
        if (file.target.resultRevision !== request.actual.revision) throw new Error("模拟已确认回执不可改变");
        return structuredClone(state);
      }
      // The final editor has already changed and checkpointed its D/B. Fail the
      // journal write, not the editor transaction; recovery must observe its receipt.
      if (this.failEditorConfirmation && file === state.files.at(-1)) {
        entry.application = { ...state, status: "recoveryRequired" };
        throw new Error("模拟编辑器签收日志尚未写入");
      }
      const files = state.files.map((item) => item === file ? { ...file, phase: "acknowledged" as const,
        target: { ...file.target, resultRevision: request.actual.revision } } : item);
      entry.application = { ...state, files, status: files.every((item) => item.phase === "acknowledged") ? "applied" : "applying" };
      return structuredClone(entry.application);
    }
    return unsupported();
  }
}
