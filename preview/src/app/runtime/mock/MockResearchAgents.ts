import { decodeAgentNoteSubmissionPreview, decodeAgentReadingNoteSubmissionPreview, decodeAgentPaperSubmissionPreview, type AgentNoteSubmissionPreview, type AgentPaperSubmissionPreview, type AgentReadingNoteSubmissionPreview, type AgentSubmissionInput, type AgentModelSelection, type AgentContextText, type AgentUserInput, type AgentPaperStartRequest } from "@research-assistant/core/agent";
import type { AppGateways } from "@research-assistant/workbench-preview/app-gateway-types";
import type { PreviewControls } from "@research-assistant/workbench-preview/app-runtime";
import type { MockWritingAgents } from "./MockWritingAgents";
import { createMockResearchContexts } from "@research-assistant/literature-library-preview";
import { WritingDemoSingleText } from "@research-assistant/workbench-preview/writing-demo-single-text";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-preview/writing-submission-controller";
import {MockPaperReceipts} from "./mockPaperReceipts";

type Preview = AgentNoteSubmissionPreview | AgentReadingNoteSubmissionPreview | AgentPaperSubmissionPreview;
/** Mock evidence and event I/O for the existing note/reader hosts. No UI fork. */
export class MockResearchAgents {
  private readonly records: Map<string, Preview>;
  readonly paperReceipts: MockPaperReceipts;
  private readonly contexts: ReturnType<typeof createMockResearchContexts>;
  private readonly running = new Map<string, { admission: WritingSubmissionAdmission; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly storage: Storage, private readonly agents: MockWritingAgents, private readonly controls: PreviewControls) {
    this.records = new Map(JSON.parse(storage.getItem("research-submissions") ?? "[]") as [string, Preview][]);
    this.paperReceipts = new MockPaperReceipts(storage);
    this.contexts = createMockResearchContexts(storage);
  }
  private store<T extends Preview>(preview: T): T {
    this.records.set(preview.requestId, structuredClone(preview));
    this.storage.setItem("research-submissions", JSON.stringify([...this.records]));
    return preview;
  }
  private input(request: { text: string; model?: AgentModelSelection | null; userInput?: readonly AgentUserInput[] }, context: readonly AgentContextText[]): AgentSubmissionInput {
    return { text: request.text, ...(request.userInput ? { userInput: request.userInput } : {}), model: { providerId: request.model?.providerId ?? "deepseek", modelId: request.model?.modelId ?? "deepseek-v4-pro", revision: "preview-v1" }, reasoningEffort: request.model?.reasoningEffort ?? null, context };
  }
  private async preparePaper(request: Parameters<NonNullable<AppGateways["agentPaperSubmissionGateway"]>["prepare"]>[0], expectedEpoch?: string) {
    const prior = this.paperReceipts.prior(request, expectedEpoch); if (prior) return {preview: prior, replayed: true};
    const context = await this.contexts.paper.preview({paperId: request.paperId, snapshotId: request.paperContextSnapshotId, expectedContextHash: request.expectedContextHash});
    const preview = this.store(decodeAgentPaperSubmissionPreview({schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId, paperId: request.paperId, paperContextSnapshotId: request.paperContextSnapshotId, turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(), input: this.input(request, context.items.map(source => ({kind: "paper", resourceId: request.paperId, sourceId: source.sourceId, revision: `sha256:${source.contentSha256}`, anchor: JSON.stringify(source), text: source.text ?? ""})))}));
    this.paperReceipts.prepared(request, preview, expectedEpoch); return {preview, replayed: false};
  }
  private restore<T extends Preview>(requestId: string, guard: (value: unknown) => T): T {
    const value = this.records.get(requestId); if (!value) throw new Error("模拟冻结提交不存在"); return guard(value);
  }
  private paperStartStatus(request: AgentPaperStartRequest) {
    const status = this.paperReceipts.start(request); if (status.status.type !== "started") return status;
    const result = status.status.result, events = this.agents.backend(request.paperId, "paper").agent.history.snapshot().events.get(request.conversationId) ?? [];
    const uncertain = () => ({schemaVersion: 1 as const, intent: status.intent, status: {type: "unconfirmed" as const,
      detail: {operationId: request.requestId, epoch: this.paperReceipts.epoch, sqlFence: "0", phase: "paper-start-status", sqliteCode: null, sqliteExtendedCode: null, safeCause: "mock_history_unconfirmed"}}});
    const starts = events.filter(event => event.payload.type === "turnStarted" && (event.payload.turnId === result.turnId || event.requestId === request.requestId));
    const first = starts[0];
    if (starts.length !== 1 || !first || first.payload.type !== "turnStarted" || first.requestId !== request.requestId || first.payload.turnId !== result.turnId
      || first.payload.contextSnapshotId !== request.contextSnapshotId || JSON.stringify(first.payload.model) !== JSON.stringify(request.model)
      || (first.payload.taskKind ?? "regular") !== "regular") return uncertain();
    const finishes = events.filter(event => event.payload.type === "turnFinished" && event.payload.turnId === result.turnId);
    if (finishes.length > 1 || finishes.some(event => event.requestId !== request.requestId)) return uncertain();
    const finish = finishes[0];
    const outcome = finish?.payload.type === "turnFinished" ? finish.payload.outcome : null;
    return {...status, status: {type: "started" as const, result: {...result, outcome}}};
  }
  private async start(preview: Preview, expectedEpoch?: string) {
    await this.controls.beforeOperation("agent");
    if (expectedEpoch && expectedEpoch !== this.paperReceipts.epoch) throw new Error("DATA_SQL_OPERATION_CONFLICT: data_epoch_changed");
    const kind = "pageId" in preview ? "note" : "readingNoteId" in preview ? "readingNote" : "paper";
    const id = "pageId" in preview ? preview.pageId : "readingNoteId" in preview ? preview.readingNoteId : preview.paperId;
    const backend = this.agents.backend(id, kind), history = backend.agent.history;
    const admission: WritingSubmissionAdmission = { scope: { manuscriptId: id, conversationId: preview.conversationId, requestId: preview.requestId, contextSnapshotId: preview.contextSnapshotId }, turnId: preview.turnId };
    if (this.running.has(preview.conversationId)) throw new Error("模拟对话正在运行");
    history.start(admission, preview.input.text, preview.input.model);
    const stream = new WritingDemoSingleText(`已读取当前${kind === "paper" ? "文献" : "笔记"}上下文。这是一条模拟回复，用于验证对话、流式输出与停止行为。`);
    const step = () => {
      stream.next(history, admission);
      if (!stream.remainingSteps) { history.complete(admission, [], true); this.running.delete(preview.conversationId); return; }
      const timer = setTimeout(step, 50); this.running.set(preview.conversationId, { admission, timer });
    };
    const timer = setTimeout(step, Math.max(100, this.controls.delayMs));
    this.running.set(preview.conversationId, { admission, timer });
    return { schemaVersion: 1 as const, conversationId: preview.conversationId, requestId: preview.requestId, turnId: preview.turnId, alreadyStarted: false, outcome: null };
  }
  async interrupt(conversationId: string): Promise<boolean> {
    const value = this.running.get(conversationId); if (!value) return false;
    clearTimeout(value.timer); this.running.delete(conversationId);
    this.agents.backend(value.admission.scope.manuscriptId).agent.history.finish(value.admission, "canceled"); return true;
  }
  gateways(): Partial<AppGateways> {
    return {
      agentNoteContextGateway: this.contexts.note, agentReadingNoteContextGateway: this.contexts.reading, agentPaperContextGateway: this.contexts.paper,
      agentPaperReadingHistoryMigrationGateway: { migrate: async request => ({ schemaVersion: 1, paperId: request.paperId, migratedCount: 0, skippedCount: 0 }) },
      agentNoteSubmissionGateway: {
        prepare: async request => this.store(decodeAgentNoteSubmissionPreview({ schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId, pageId: request.context.pageId, turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(), input: this.input(request, [(await this.contexts.note.preview(request.context)).source]) })),
        restore: async request => this.restore(request.requestId, decodeAgentNoteSubmissionPreview), start: preview => this.start(preview),
      },
      agentReadingNoteSubmissionGateway: {
        prepare: async request => this.store(decodeAgentReadingNoteSubmissionPreview({ schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId, readingNoteId: request.context.readingNoteId, turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(), input: this.input(request, [(await this.contexts.reading.preview(request.context)).source]) })),
        restore: async request => this.restore(request.requestId, decodeAgentReadingNoteSubmissionPreview), start: preview => this.start(preview),
      },
      agentPaperSubmissionGateway: {
        prepare: async request => (await this.preparePaper(request)).preview,
        restore: async request => this.restore(request.requestId, decodeAgentPaperSubmissionPreview), start: async (preview, _mode, options) => {
          const result = await this.start(preview, options?.expectedEpoch); this.paperReceipts.started(preview, result); return result;
        },
        steer: async request => { const running = this.running.get(request.conversationId); if (!running) throw new Error("模拟回合已经结束"); this.agents.backend(request.paperId, "paper").agent.history.steer(running.admission, request.inputId, request.text); return { schemaVersion: 1, conversationId: request.conversationId, turnId: request.turnId, inputId: request.inputId }; },
        sources: async request => ({ schemaVersion: 1, ...request, sources: [] }),
      },
      agentPaperPrepareStatusGateway: {read: async (request, options) => {
        if (options && options.expectedEpoch !== this.paperReceipts.epoch) throw new Error("DATA_SQL_OPERATION_CONFLICT: data_epoch_changed");
        return this.paperReceipts.preparation(request, options?.expectedEpoch);
      }},
      agentPaperPrepareProvenGateway: {prepare: async (request, options) => {
        if (options && options.expectedEpoch !== this.paperReceipts.epoch) throw new Error("DATA_SQL_OPERATION_CONFLICT: data_epoch_changed");
        const {replayed} = await this.preparePaper(request, options?.expectedEpoch);
        const status = this.paperReceipts.preparation(request, options?.expectedEpoch).status;
        if (status.type !== "committed") throw new Error("模拟准备回执不可用");
        return {...status, proof: {...status.proof, replayed}};
      }},
      agentPaperStartStatusGateway: {read: async (request, options) => {
        if (options && options.expectedEpoch !== this.paperReceipts.epoch) throw new Error("DATA_SQL_OPERATION_CONFLICT: data_epoch_changed");
        return this.paperStartStatus(request);
      }},
      agentNoteRecoveryGateway: { list: async request => ({ schemaVersion: 1, conversationId: request.conversationId, pageId: request.pageId, items: [], nextCursor: null }) },
      agentPaperRecoveryGateway: { list: async request => ({ schemaVersion: 1, conversationId: request.conversationId, paperId: request.paperId, items: [], nextCursor: null }) },
      agentReadingNoteRecoveryGateway: { list: async request => ({ schemaVersion: 1, conversationId: request.conversationId, readingNoteId: request.readingNoteId, items: [], nextCursor: null }) },
    };
  }
  dispose(): void { for (const running of this.running.values()) clearTimeout(running.timer); this.running.clear(); }
}
