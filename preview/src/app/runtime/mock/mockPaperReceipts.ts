import {agentQueueEditIntentFromRequest, decodeAgentPaperSubmissionPrepareRequest, decodeAgentPaperSubmissionPreview, decodeAgentPaperPrepareResult,
  decodeAgentPaperStartRequest, decodeAgentPaperQueueEditRequest, sameAgentPaperPrepareRequest,
  type AgentPaperSubmissionPrepareRequest, type AgentPaperSubmissionPreview, type AgentPaperStartRequest,
  type AgentStartResponse, type AgentPaperQueueEditRequest, type AgentPaperQueueResponse} from "@research-assistant/core/agent";

/** Mock persistence port. Production recovery and queue controllers remain shared. */
export class MockPaperReceipts {
  readonly epoch: string;
  private readonly paper: Map<string, {intent: AgentPaperSubmissionPrepareRequest; preview: AgentPaperSubmissionPreview; started: AgentStartResponse | null; expectedEpoch?: string}>;
  private readonly queue: Map<string, {request: AgentPaperQueueEditRequest; result: AgentPaperQueueResponse}>;
  constructor(private readonly storage: Storage) {
    const epoch = storage.getItem("mock-paper-epoch"); this.epoch = epoch ?? crypto.randomUUID();
    if (!epoch) storage.setItem("mock-paper-epoch", this.epoch);
    this.paper = new Map(JSON.parse(storage.getItem("mock-paper-receipts") ?? "[]"));
    this.queue = new Map(JSON.parse(storage.getItem("mock-paper-queue-receipts") ?? "[]"));
  }
  private persistPaper(): void {this.storage.setItem("mock-paper-receipts", JSON.stringify([...this.paper]));}
  private persistQueue(): void {this.storage.setItem("mock-paper-queue-receipts", JSON.stringify([...this.queue]));}
  queueScopeId(paperId: string): string {
    if (/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(paperId) && paperId !== "00000000-0000-0000-0000-000000000000") return paperId.toLowerCase();
    const key = `mock-paper-queue-scope:${encodeURIComponent(paperId)}`;
    const existing = this.storage.getItem(key); if (existing) return existing;
    const id = crypto.randomUUID(); this.storage.setItem(key, id); return id;
  }
  prior(input: AgentPaperSubmissionPrepareRequest, expectedEpoch?: string): AgentPaperSubmissionPreview | null {
    const intent = decodeAgentPaperSubmissionPrepareRequest(input), record = this.paper.get(intent.requestId);
    if (!record) return null;
    if (!sameAgentPaperPrepareRequest(intent, record.intent) || record.expectedEpoch !== expectedEpoch) throw new Error("模拟论文请求身份冲突");
    return decodeAgentPaperSubmissionPreview(record.preview);
  }
  prepared(input: AgentPaperSubmissionPrepareRequest, preview: AgentPaperSubmissionPreview, expectedEpoch?: string): void {
    const intent = decodeAgentPaperSubmissionPrepareRequest(input);
    if (this.prior(intent, expectedEpoch)) throw new Error("模拟论文请求已存在");
    this.paper.set(intent.requestId, {intent, preview: decodeAgentPaperPrepareResult(preview, intent), started: null, ...(expectedEpoch ? {expectedEpoch} : {})});
    try {this.persistPaper();} catch (cause) {this.paper.delete(intent.requestId); throw cause;}
  }
  started(preview: AgentPaperSubmissionPreview, result: AgentStartResponse): void {
    const record = this.paper.get(preview.requestId);
    if (!record || JSON.stringify(record.preview) !== JSON.stringify(preview)) return;
    if (result.conversationId !== preview.conversationId || result.requestId !== preview.requestId || result.turnId !== preview.turnId) throw new Error("模拟启动回执身份冲突");
    this.paper.set(preview.requestId, {...record, started: structuredClone(result)});
    try {this.persistPaper();} catch (cause) {this.paper.set(preview.requestId, record); throw cause;}
  }
  preparation(input: AgentPaperSubmissionPrepareRequest, expectedEpoch?: string) {
    const intent = decodeAgentPaperSubmissionPrepareRequest(input), preview = this.prior(intent, expectedEpoch);
    if (!preview) return {schemaVersion: 1 as const, intent, status: {type: "unconfirmed" as const, detail: this.detail(intent.requestId, "paper-prepare-status")}};
    return {schemaVersion: 1 as const, intent, status: {type: "committed" as const, result: preview, proof: {
      schemaVersion: 1 as const, operationId: intent.requestId, conversationId: intent.conversationId,
      family: "agent.paper.submission.prepare" as const, epoch: this.epoch, sqlFence: "0", replayed: true, result: null,
    }}};
  }
  start(input: AgentPaperStartRequest) {
    const intent = decodeAgentPaperStartRequest(input), record = this.paper.get(intent.requestId), preview = record?.preview;
    if (!record?.started || !preview || preview.conversationId !== intent.conversationId || preview.paperId !== intent.paperId
      || preview.paperContextSnapshotId !== intent.paperContextSnapshotId || preview.contextSnapshotId !== intent.contextSnapshotId
      || JSON.stringify(preview.input.model) !== JSON.stringify(intent.model))
      return {schemaVersion: 1 as const, intent, status: {type: "unconfirmed" as const, detail: this.detail(intent.requestId, "paper-start-status")}};
    return {schemaVersion: 1 as const, intent, status: {type: "started" as const, result: {...record.started, alreadyStarted: true}}};
  }
  queueEdit(input: AgentPaperQueueEditRequest, result: AgentPaperQueueResponse): void {
    const request = decodeAgentPaperQueueEditRequest(input), existing = this.queue.get(request.requestId);
    const removed = request.edit.type === "remove" ? request.edit.inputId : null;
    if (result.conversationId !== request.conversationId || result.paperId !== request.paperId || result.revision !== request.expectedRevision + 1
      || removed !== null && result.inputs.some(item => item.inputId === removed)) throw new Error("模拟队列回执身份冲突");
    if (existing && (JSON.stringify(existing.request) !== JSON.stringify(request) || JSON.stringify(existing.result) !== JSON.stringify(result))) throw new Error("模拟队列请求身份冲突");
    this.queue.set(request.requestId, {request, result: structuredClone(result)});
    try {this.persistQueue();} catch (cause) {if (existing) this.queue.set(request.requestId, existing); else this.queue.delete(request.requestId); throw cause;}
  }
  queueStatus(input: AgentPaperQueueEditRequest) {
    const request = decodeAgentPaperQueueEditRequest(input), record = this.queue.get(request.requestId), intent = agentQueueEditIntentFromRequest(request);
    if (request.expectedEpoch && request.expectedEpoch !== this.epoch) throw new Error("DATA_SQL_OPERATION_CONFLICT: data_epoch_changed");
    if (!record) return {schemaVersion: 1 as const, intent, status: {type: "unconfirmed" as const, detail: this.detail(request.requestId, "queue-edit-status")}};
    if (JSON.stringify(record.request) !== JSON.stringify(request)) throw new Error("模拟队列请求身份冲突");
    const {paperId: _paperId, ...queue} = record.result;
    return {schemaVersion: 1 as const, intent, status: {type: "committed" as const, queue, proof: {
      schemaVersion: 1 as const, operationId: request.requestId, conversationId: request.conversationId,
      family: "agent.input_queue.edit" as const, epoch: this.epoch, sqlFence: "0", replayed: true, result: null,
    }}};
  }
  private detail(operationId: string, phase: string) {return {operationId, epoch: this.epoch, sqlFence: "0", phase,
    sqliteCode: null, sqliteExtendedCode: null, safeCause: "mock_receipt_unconfirmed"};}
}
