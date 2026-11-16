import { decodeAgentArchiveRequest, decodeAgentCatalogPage, decodeAgentRenameResponse, decodeAgentRenameRequest, decodeAgentCreateBoundRequest, decodeAgentSearchPage, decodeAgentDeletionResponse, decodeAgentDeletionWriteOptions, decodeAgentForkRequest, decodeAgentForkResponse, decodeAgentForkOriginResponse, decodeAgentForkWriteOptions,
  type AgentConversationBinding, type AgentConversationSummary, type AgentDeletionRequest, type AgentDeletionResponse, type AgentDeletionWriteOptions,
  type AgentCreateBoundRequest, type AgentCreateBoundProof } from "@research-assistant/core/agent";
import type { AgentArchiveGateway, AgentCatalogGateway, AgentCreationGateway, AgentMetadataGateway, AgentSearchGateway, AgentDeletionGateway, AgentDeletionBatchGateway, AgentForkGateway, AgentForkOriginGateway } from "@research-assistant/data/agent";
import type { WritingAgentHistoryAccess } from "../../../../../src/features/writing/useWritingAgentHistory";
import type { WritingDiffDemoAgentStorage } from "./WritingDiffDemoAgentStorage";
import { MockRenameReceipts } from "@research-assistant/workbench-preview/mock-rename-receipts";
import { MockCreateBoundReceipts } from "@research-assistant/workbench-preview/mock-create-bound-receipts";
import { MockArchiveReceipts } from "@research-assistant/workbench-preview/mock-archive-receipts";
import { MockForkReceipts } from "@research-assistant/workbench-preview/mock-fork-receipts";
import { MockDeletionReceipts } from "@research-assistant/workbench-preview/mock-deletion-receipts";
import { mockConversationDeletionBatch, type MockConversationDeletionPlan } from "@research-assistant/workbench-preview/mock-conversation-deletion-batch";

/** Mock conversation persistence; shared production list/history own selection UI. */
export class WritingDiffDemoConversations {
  dataEpoch():string{return this.renames.epochId();}
  snapshot() { return structuredClone({ records: this.records, origins: this.origins, deletedRequests: this.deletedRequests, selected: this.selected,
    renames: this.renames.snapshot(), creations: this.creations.snapshot(), archiveReceipts: this.archiveReceipts.snapshot(), forkReceipts: this.forkReceipts.snapshot(), deletionReceipts: this.deletionReceipts.snapshot(), bindings: this.bindings }); }
  restore(snapshot: ReturnType<WritingDiffDemoConversations["snapshot"]>): void {
    this.records.clear(); for (const entry of snapshot.records) this.records.set(entry[0], entry[1]);
    this.origins.clear(); for (const entry of snapshot.origins) this.origins.set(entry[0], entry[1]);
    this.deletedRequests.clear(); for (const entry of snapshot.deletedRequests) this.deletedRequests.set(entry[0], entry[1]);
    this.selected = snapshot.selected;
    this.renames.restore(snapshot.renames);
    this.creations.restore(snapshot.creations);
    this.archiveReceipts.restore(snapshot.archiveReceipts);
    this.forkReceipts.restore(snapshot.forkReceipts);
    this.deletionReceipts.restore(snapshot.deletionReceipts, snapshot.deletedRequests);
    this.bindings.clear();
    // Legacy fixture snapshots represented one already-bound host per backend.
    for (const [id, binding] of snapshot.bindings ?? [...snapshot.records.keys()].map(id => [id, this.hostBinding()] as const)) this.bindings.set(id, binding);
  }

  private readonly records = new Map<string, AgentConversationSummary>();
  foreignOperationExists: (id: string) => boolean = () => false;
  private readonly renames: MockRenameReceipts = new MockRenameReceipts(id => this.creations.has(id) || this.archiveReceipts.has(id) || this.forkReceipts.has(id) || this.deletionReceipts.has(id) || this.foreignOperationExists(id));
  private readonly creations: MockCreateBoundReceipts = new MockCreateBoundReceipts(() => this.renames.epochId(), id => this.renames.has(id) || this.archiveReceipts.has(id) || this.forkReceipts.has(id) || this.deletionReceipts.has(id) || this.foreignOperationExists(id));
  private readonly archiveReceipts: MockArchiveReceipts = new MockArchiveReceipts(() => this.renames.epochId(), id => this.renames.has(id) || this.creations.has(id) || this.forkReceipts.has(id) || this.deletionReceipts.has(id) || this.foreignOperationExists(id));
  private readonly forkReceipts: MockForkReceipts = new MockForkReceipts(() => this.renames.epochId(), id => this.renames.has(id) || this.creations.has(id) || this.archiveReceipts.has(id) || this.deletionReceipts.has(id) || this.foreignOperationExists(id));
  private readonly deletionReceipts: MockDeletionReceipts = new MockDeletionReceipts(() => this.renames.epochId(), id => this.renames.has(id) || this.creations.has(id) || this.archiveReceipts.has(id) || this.forkReceipts.has(id) || this.foreignOperationExists(id));
  private readonly bindings = new Map<string, AgentConversationBinding>();
  hasCreationOperation(operationId: string): boolean { return this.creations.has(operationId); }
  hasArchiveOperation(operationId: string): boolean { return this.archiveReceipts.has(operationId); }
  /** Fixture classification only; production catalog controls own all rendering. */
  markInternal(id: string): void {
    const row = this.records.get(id);
    if (!row) throw new Error("模拟对话不存在");
    this.records.set(id, {...row, internal: true});
  }
  private readonly origins = new Map<string, { parentId: string; throughTurnId: string; parentEndSeq: number }>();
  private readonly deletedRequests = new Map<string, string>();
  private readonly deleting = new Map<string, { fingerprint: string; result: Promise<AgentDeletionResponse> }>();
  private selected: string | null;
  constructor(readonly manuscriptId: string, readonly agent: WritingDiffDemoAgentStorage, firstId: string,
    private readonly onDeleted: (id: string) => void = () => undefined,
    private readonly hasPreparedWorkspace: (id: string) => boolean = () => false,
    private readonly bindingKind: AgentConversationBinding["kind"] = "manuscript",
    private readonly resourceAvailable: () => boolean = () => true) {
    this.selected = firstId;
    this.create(firstId, "完善摘要");
    this.create(crypto.randomUUID(), "第二个对话");
  }
  private check(binding?: AgentConversationBinding | null): void {
    if (binding && (binding.kind !== this.bindingKind || binding.resourceId !== this.manuscriptId)) throw new Error("模拟对话稿件身份不匹配");
  }
  private hostBinding(): AgentConversationBinding { return {kind: this.bindingKind, resourceId: this.manuscriptId}; }
  private create(id: string, title = "新对话"): AgentConversationSummary {
    this.agent.history.assertAvailable(id);
    const now = new Date().toISOString();
    const value = decodeAgentRenameResponse({ schemaVersion: 1, conversation: { id, title, archived: false,
      durableCount: 0, createdAt: now, updatedAt: now } }).conversation;
    this.records.set(id, value); this.bindings.set(id, this.hostBinding()); return structuredClone(value);
  }
  private async read(id: string): Promise<AgentConversationSummary> {
    await this.agent.initialized;
    const value = this.records.get(id);
    if (!value) throw "notFound";
    return { ...value, durableCount: (await this.agent.gateways.delivery.sessions.open(id)).watermark };
  }
  readonly selection: WritingAgentHistoryAccess["selection"] = {
    read: (binding) => { this.check(binding); return this.selected; },
    write: (binding, id) => { this.check(binding); this.selected = id; },
    clear: (binding, id) => { this.check(binding); if (!id || this.selected === id) this.selected = null; },
  };
  readonly metadata: AgentMetadataGateway = { read: async ({ id, binding }) => { this.check(binding); return this.read(id); } };
  /** Called after initialized; the synthetic metadata mutation and receipt have no await between them. */
  createBoundReady(request: AgentCreateBoundRequest): AgentCreateBoundProof {
    return this.creations.apply(request, value => {
      this.check(value.binding); if (!this.resourceAvailable()) throw "notFound";
    }, ({id, binding}) => {
      if (this.records.has(id)) {
        const original = this.bindings.get(id);
        if (!original || original.kind !== binding.kind || original.resourceId !== binding.resourceId) throw "conflict";
      } else this.create(id);
    });
  }
  readonly creation: AgentCreationGateway = {
    createBound: async input => {
      const frozen = decodeAgentCreateBoundRequest(input);
      await this.agent.initialized;
      return this.createBoundReady(frozen);
    },
    createBoundStatus: async request => this.creations.status(request),
  };
  readonly forks: AgentForkGateway = { status: async request => this.forkReceipts.status(request), fork: async (input, options) => {
    const request = decodeAgentForkRequest(input);
    const expected = options === undefined ? undefined : decodeAgentForkWriteOptions(options).expectedEpoch;
    const checkEpoch = () => {
      if (expected !== undefined && expected !== this.renames.epochId()) throw {
        code: "storage", reason: { code: "DATA_SQL_OPERATION_CONFLICT", reason: {
          operationId: request.childId, epoch: this.renames.epochId(), sqlFence: "0", phase: "fork-epoch", safeCause: "data_epoch_changed",
        } },
      };
    };
    checkEpoch();
    const replay = this.forkReceipts.lookup(request);
    if (replay) {
      const origin = this.origins.get(request.childId);
      if (!origin) throw "corrupt";
      return decodeAgentForkResponse({ schemaVersion: 1, conversation: await this.read(request.childId), ...origin });
    }
    this.check(request.binding);
    const parent = await this.read(request.parentId);
    checkEpoch();
    let origin = this.origins.get(request.childId);
    if (origin && (origin.parentId !== request.parentId || origin.throughTurnId !== request.throughTurnId)) throw "conflict";
    if (!origin) this.forkReceipts.apply(request, () => {
      if (this.records.has(request.childId)) throw "conflict";
      const parentEndSeq = this.agent.history.fork(request.parentId, request.childId, request.throughTurnId);
      origin = { parentId: request.parentId, throughTurnId: request.throughTurnId, parentEndSeq };
      this.create(request.childId, `${parent.title}（分支）`);
      this.origins.set(request.childId, origin);
    });
    return decodeAgentForkResponse({ schemaVersion: 1, conversation: await this.read(request.childId), ...this.origins.get(request.childId) });
  } };
  readonly forkOrigin: AgentForkOriginGateway = { read: async ({ conversationId, binding }) => {
    this.check(binding); await this.read(conversationId);
    const origin = this.origins.get(conversationId);
    return decodeAgentForkOriginResponse({ schemaVersion: 1, conversationId,
      origin: origin ? { parent: await this.read(origin.parentId), throughTurnId: origin.throughTurnId, parentEndSeq: origin.parentEndSeq } : null });
  } };
  readonly catalog: AgentCatalogGateway = {
    activity: async ({binding}) => {
      this.check(binding);
      return [...this.records.values()].filter(row => !row.archived && this.agent.history.activeTurn(row.id))
        .map(row => ({id: row.id, internal: Boolean(row.internal)}));
    },
    rename: async request => {
      const frozen = decodeAgentRenameRequest(request), replay = this.renames.lookup(frozen);
      if (replay) return replay;
      await this.read(frozen.id);
      return this.renames.apply(frozen, ({ id, expectedTitle, title }) => {
        const current = this.records.get(id);
        if (!current) throw "notFound";
        if (current.title !== expectedTitle) throw "conflict";
        const next = decodeAgentRenameResponse({ schemaVersion: 1, conversation: { ...current, title: title.trim(), updatedAt: new Date().toISOString() } }).conversation;
        this.agent.history.assertAvailable(id);
        this.records.set(id, next);
      });
    },
    renameStatus: async request => this.renames.status(request),
    list: async (request) => {
      this.check(request.binding);
      const all = (await Promise.all([...this.records.keys()].map(id => this.read(id))))
        .filter(item => item.archived === request.archived && Boolean(item.internal) === Boolean(request.internal))
        .sort((left, right) => left.createdAt === right.createdAt ? (left.id < right.id ? 1 : -1) : left.createdAt < right.createdAt ? 1 : -1)
        .filter(item => !request.before || item.createdAt < request.before.createdAt || (item.createdAt === request.before.createdAt && item.id < request.before.id));
      const conversations = all.slice(0, request.limit), last = conversations.at(-1);
      return decodeAgentCatalogPage({ schemaVersion: 1, conversations, next: all.length > conversations.length && last ? { id: last.id, createdAt: last.createdAt } : null });
    },
  };
  readonly archives: AgentArchiveGateway = {
    setArchived: async input => {
      const request = decodeAgentArchiveRequest(input);
      const replay = this.archiveReceipts.lookup(request);
      if (replay) return replay;
      await this.agent.initialized;
      return this.archiveReceipts.apply(request, frozen => {
        const current = this.records.get(frozen.id);
        if (!current) throw "notFound";
        this.agent.history.assertAvailable(frozen.id);
        if (frozen.archived) {
          this.agent.history.assertIdle(frozen.id);
          this.agent.history.assertWatermark(frozen.id, frozen.expectedWatermark!);
        }
        if (current.archived !== frozen.archived) this.records.set(frozen.id,
          { ...current, archived: frozen.archived, updatedAt: new Date().toISOString() });
      });
    },
    archiveStatus: async request => this.archiveReceipts.status(request),
  };
  private validateDeletion(request: AgentDeletionRequest): void {
    const current = this.records.get(request.conversationId);
    if (!current) throw "notFound";
    if (!current.archived) throw "notArchived";
    if (current.title !== request.expectedTitle) throw "conflict";
    this.agent.history.assertIdle(request.conversationId);
    if (!request.force && (this.agent.hasExecutionWorkspace(request.conversationId) || this.hasPreparedWorkspace(request.conversationId))) throw "executionWorkspace";
  }
  private async delete(request: AgentDeletionRequest, fingerprint: string, options?: AgentDeletionWriteOptions): Promise<AgentDeletionResponse> {
    if (request.binding && (request.binding.kind !== this.bindingKind || request.binding.resourceId !== this.manuscriptId)) throw "notFound";
    await this.read(request.conversationId);
    await this.agent.deleteConversation(request.conversationId, request.expectedDurableCount, () => this.validateDeletion(request),
      removeHistory => {
        this.deletionReceipts.validateWrite(request, options);
        this.deletionReceipts.apply(request, () => {
          removeHistory();
          this.records.delete(request.conversationId); this.bindings.delete(request.conversationId);
          if (this.selected === request.conversationId) this.selected = null;
          this.deletedRequests.set(request.requestId, fingerprint);
        });
      });
    this.onDeleted(request.conversationId);
    return decodeAgentDeletionResponse({ schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId });
  }
  readonly deletions: AgentDeletionGateway = { status: async request => this.deletionReceipts.status(request), delete: async (input, options) => {
    const precondition = options === undefined ? undefined : decodeAgentDeletionWriteOptions(options);
    const request = this.deletionReceipts.validateWrite(input, precondition), fingerprint = JSON.stringify(request);
    const saved = this.deletedRequests.get(request.requestId);
    if (saved) {
      if (saved !== fingerprint) throw "conflict";
      return decodeAgentDeletionResponse({ schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId });
    }
    const pending = this.deleting.get(request.requestId);
    if (pending) { if (pending.fingerprint !== fingerprint) throw "conflict"; return pending.result; }
    const result = this.delete(request, fingerprint, precondition), entry = { fingerprint, result };
    this.deleting.set(request.requestId, entry);
    try { return await result; }
    finally { if (this.deleting.get(request.requestId) === entry) this.deleting.delete(request.requestId); }
  } };
  async prepareBatchDeletion(request: AgentDeletionRequest): Promise<MockConversationDeletionPlan> {
    if (request.binding && (request.binding.kind !== this.bindingKind || request.binding.resourceId !== this.manuscriptId)) throw "notFound";
    await this.read(request.conversationId);
    await this.agent.waitForDeletion();
    const validate = () => {
      this.deletionReceipts.validateWrite(request);
      if (this.deletionReceipts.replay(request)) throw "conflict";
      this.validateDeletion(request);
      this.agent.history.assertWatermark(request.conversationId, request.expectedDurableCount);
    };
    validate();
    const catalog = this.snapshot(), history = this.agent.history.snapshot(), agent = this.agent.snapshot();
    return {validate, publish: () => this.deletionReceipts.apply(request, () => {
      this.agent.deleteConversationReady(request.conversationId, request.expectedDurableCount);
      this.records.delete(request.conversationId); this.bindings.delete(request.conversationId);
      if (this.selected === request.conversationId) this.selected = null;
      this.deletedRequests.set(request.requestId, JSON.stringify(request));
    }), rollback: () => {this.restore(catalog); this.agent.history.restore(history); this.agent.restore(agent);},
    finish: () => this.onDeleted(request.conversationId)};
  }
  readonly batchDeletions: AgentDeletionBatchGateway = {deleteBatch: requests => mockConversationDeletionBatch(requests, request => this.prepareBatchDeletion(request))};
  readonly search: AgentSearchGateway = { search: async ({ term, scope }) => {
    const page = await this.catalog.list(scope);
    return decodeAgentSearchPage({ schemaVersion: 1, hits: page.conversations.filter(item => item.title.includes(term.trim()))
      .map(conversation => ({ conversation, excerpt: conversation.title, itemId: null, turnId: null, startSeq: null, completed: true })), next: null });
  } };
}
