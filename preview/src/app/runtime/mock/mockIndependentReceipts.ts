import {decodeAgentContextPrepareIntent, decodeAgentContextPrepareStatusResponse, decodeAgentContextStartRequest,
  decodeAgentContextStartStatusResponse, sameAgentContextPrepareIntent,
  type AgentContextPrepareIntent, type AgentContextPrepareRequest, type AgentContextPreview, type AgentContextStartRequest,
  type AgentStartResponse, type AgentEvent} from "@research-assistant/core/agent";
import type {AgentContextPrepareProvenGateway, AgentContextPrepareStatusGateway, AgentContextStartGateway} from "@research-assistant/data/agent";

interface Receipt {readonly intent: AgentContextPrepareIntent; readonly epoch: string; readonly expectedEpoch: string | null; readonly preview: AgentContextPreview}
/** Synthetic persistence and external effects; production recovery owns the lifecycle. */
export class MockIndependentReceipts {
  readonly epoch: string;
  private readonly rows: Map<string, Receipt>;
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly storage: Storage, private readonly prepare: (request: AgentContextPrepareRequest) => Promise<AgentContextPreview>,
    private readonly start: (preview: AgentContextPreview, resumeQueue: boolean) => Promise<AgentStartResponse>,
    private readonly events: (conversationId: string) => readonly AgentEvent[], sharedEpoch?: string,
    private readonly isAdmitted: (preview: AgentContextPreview) => boolean = () => false) {
    const epoch = storage.getItem("independent-prepare-epoch");
    if (epoch && sharedEpoch && epoch !== sharedEpoch) throw new Error("模拟独立数据环境不一致");
    this.epoch = epoch ?? sharedEpoch ?? crypto.randomUUID();
    if (!epoch) storage.setItem("independent-prepare-epoch", this.epoch);
    this.rows = new Map(JSON.parse(storage.getItem("independent-prepare-receipts") ?? "[]"));
  }
  private guard(epoch?: string): void {if (epoch && epoch !== this.epoch) throw new Error("DATA_SQL_OPERATION_CONFLICT: data_epoch_changed");}
  private lookup(intent: AgentContextPrepareIntent, epoch?: string): Receipt | undefined {
    this.guard(epoch); const row = this.rows.get(intent.requestId);
    if (row && (!sameAgentContextPrepareIntent(intent, row.intent) || row.expectedEpoch !== (epoch ?? null) || row.epoch !== this.epoch)) throw new Error("模拟独立请求身份冲突");
    return row;
  }
  private detail(operationId: string, phase: string) {return {operationId, epoch: this.epoch, sqlFence: "0", phase, sqliteCode: null, sqliteExtendedCode: null, safeCause: "mock_worker_unconfirmed"};}
  private response(intent: AgentContextPrepareIntent, epoch?: string, replayed = true) {
    const row = this.lookup(intent, epoch);
    return decodeAgentContextPrepareStatusResponse({schemaVersion: 1, intent, expectedEpoch: epoch ?? null, status: row
      ? {type: "committed", proof: {schemaVersion: 1, operationId: intent.requestId, conversationId: intent.conversationId,
          family: "agent.context.submission.prepare", epoch: this.epoch, sqlFence: "0", replayed, result: null}, result: row.preview}
      : {type: "unconfirmed", detail: this.detail(intent.requestId, "context-prepare-status")}});
  }
  readonly status: AgentContextPrepareStatusGateway = {read: async (request, options) => this.response(decodeAgentContextPrepareIntent(request), options?.expectedEpoch)};
  readonly proven: AgentContextPrepareProvenGateway = {prepare: async (request, options) => {
    const intent = decodeAgentContextPrepareIntent(request), epoch = options?.expectedEpoch;
    const previous = this.pending.get(intent.requestId); if (previous) await previous;
    let response = this.response(intent, epoch);
    if (response.status.type === "committed") return response.status;
    const work = (async () => {
      const preview = await this.prepare({conversationId: intent.conversationId, requestId: intent.requestId, text: intent.text,
        resources: intent.resources, userInput: intent.userInput, ...(intent.model ? {model: intent.model} : {}),
        ...(intent.retrieval ? {retrieval: intent.retrieval} : {}), ...(intent.queue ? {queue: intent.queue} : {})});
      const row: Receipt = {intent, epoch: this.epoch, expectedEpoch: epoch ?? null, preview};
      this.rows.set(intent.requestId, row);
      try {this.storage.setItem("independent-prepare-receipts", JSON.stringify([...this.rows]));}
      catch (cause) {this.rows.delete(intent.requestId); throw cause;}
    })();
    this.pending.set(intent.requestId, work);
    try {await work;} finally {if (this.pending.get(intent.requestId) === work) this.pending.delete(intent.requestId);}
    response = this.response(intent, epoch, false);
    if (response.status.type !== "committed") throw new Error("模拟独立回执不可用");
    return response.status;
  }};
  private startReceipt(request: AgentContextStartRequest, epoch: string): Receipt {
    this.guard(epoch); const row = this.rows.get(request.requestId);
    if (!row || row.epoch !== epoch || row.preview.conversationId !== request.conversationId || row.preview.contextSnapshotId !== request.contextSnapshotId
      || JSON.stringify(row.preview.queue ?? null) !== JSON.stringify(request.queue)) throw new Error("模拟启动身份冲突");
    return row;
  }
  readonly guardedStart: AgentContextStartGateway = {
    start: async (input, epoch) => {const request = decodeAgentContextStartRequest(input), row = this.startReceipt(request, epoch); return this.start(row.preview, request.resumeQueue);},
    read: async (input, epoch) => {
      const request = decodeAgentContextStartRequest(input); this.guard(epoch);
      if (!this.rows.has(request.requestId)) return decodeAgentContextStartStatusResponse({schemaVersion: 1, intent: request, expectedEpoch: epoch,
        status: {type: "unconfirmed", detail: this.detail(request.requestId, "context-start-status")}});
      const row = this.startReceipt(request, epoch), events = this.events(request.conversationId);
      const begun = events.find(event => event.requestId === request.requestId && event.payload.type === "turnStarted" && event.payload.turnId === row.preview.turnId && event.payload.contextSnapshotId === request.contextSnapshotId
        && JSON.stringify(event.payload.model) === JSON.stringify(row.preview.input.model));
      const finished = events.find(event => event.requestId === request.requestId && event.payload.type === "turnFinished" && event.payload.turnId === row.preview.turnId);
      const outcome = finished?.payload.type === "turnFinished" ? finished.payload.outcome : null;
      return decodeAgentContextStartStatusResponse({schemaVersion: 1, intent: request, expectedEpoch: epoch, status: begun
        ? {type: "started", result: {schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId, turnId: row.preview.turnId, alreadyStarted: true, outcome}}
        : this.isAdmitted(row.preview) ? {type: "admitted", preview: row.preview}
        : {type: "unconfirmed", detail: this.detail(request.requestId, "context-start-status")}});
    },
  };
}
