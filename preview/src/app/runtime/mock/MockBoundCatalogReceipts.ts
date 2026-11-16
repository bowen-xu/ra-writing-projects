import { type AgentCreateBoundRequest, type AgentCreateBoundProof, type AgentRenameRequest, type AgentArchiveRequest, type AgentForkRequest, type AgentDeletionRequest, type AgentDeletionWriteOptions } from "@research-assistant/core/agent";
import { MockCreateBoundReceipts, type MockCreateBoundSnapshot } from "@research-assistant/workbench-preview/mock-create-bound-receipts";
import { MockRenameReceipts, type MockRenameSnapshot } from "@research-assistant/workbench-preview/mock-rename-receipts";
import { MockArchiveReceipts, type MockArchiveSnapshot } from "@research-assistant/workbench-preview/mock-archive-receipts";
import { MockForkReceipts, type MockForkSnapshot } from "@research-assistant/workbench-preview/mock-fork-receipts";
import { MockDeletionReceipts, type MockDeletionSnapshot } from "@research-assistant/workbench-preview/mock-deletion-receipts";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";

interface Records {readonly renames: MockRenameSnapshot; readonly creations: MockCreateBoundSnapshot; readonly archiveReceipts?: MockArchiveSnapshot; readonly forkReceipts?: MockForkSnapshot; readonly deletionReceipts?: MockDeletionSnapshot; readonly deletedRequests?: ReadonlyMap<string, string>}
/** Metadata-only receipt index; status never opens a simulated runtime or resource. */
export class MockBoundCatalogReceipts {
  private readonly records: Map<string, Records>;
  private readonly epoch: string;
  constructor(private readonly storage: Storage, private readonly foreignOperation: (id: string) => boolean = () => false) {
    this.records = decodeMockState(storage.getItem("agent-bound-receipts") ?? encodeMockState(new Map()));
    this.epoch = storage.getItem("agent-bound-status-epoch") ?? crypto.randomUUID();
    storage.setItem("agent-bound-status-epoch", this.epoch);
  }
  record(resourceId: string, value: Records): void {
    this.records.set(resourceId, structuredClone(value));
    this.storage.setItem("agent-bound-receipts", encodeMockState(this.records));
  }
  owner(operationId: string): string | undefined {
    return [...this.records].find(([, row]) => row.creations.entries.has(operationId) || row.renames.entries.has(operationId) || row.archiveReceipts?.entries.has(operationId) || row.forkReceipts?.entries.has(operationId) || row.deletionReceipts?.entries.has(operationId) || row.deletedRequests?.has(operationId))?.[0];
  }
  private receipts(resourceId?: string, operationId?: string) {
    const owner = operationId ? this.owner(operationId) : undefined;
    const known = owner ? this.records.get(owner) : undefined;
    const value = known ?? (resourceId ? this.records.get(resourceId) : undefined);
    const renames: MockRenameReceipts = new MockRenameReceipts(id => receipts.has(id) || archives.has(id) || forks.has(id) || deletions.has(id) || this.foreignOperation(id));
    renames.restore(value?.renames ?? {epoch: this.epoch, entries: new Map()});
    const receipts: MockCreateBoundReceipts = new MockCreateBoundReceipts(() => value ? renames.epochId() : this.epoch, id => renames.has(id) || archives.has(id) || forks.has(id) || deletions.has(id) || this.foreignOperation(id));
    receipts.restore(value?.creations);
    const archives: MockArchiveReceipts = new MockArchiveReceipts(() => renames.epochId(), id => renames.has(id) || receipts.has(id) || forks.has(id) || deletions.has(id) || this.foreignOperation(id));
    archives.restore(value?.archiveReceipts);
    const forks: MockForkReceipts = new MockForkReceipts(() => renames.epochId(), id => renames.has(id) || receipts.has(id) || archives.has(id) || deletions.has(id) || this.foreignOperation(id));
    forks.restore(value?.forkReceipts);
    const deletions = new MockDeletionReceipts(() => renames.epochId(), id => renames.has(id) || receipts.has(id) || archives.has(id) || forks.has(id) || this.foreignOperation(id));
    deletions.restore(value?.deletionReceipts, value?.deletedRequests);
    return {creations: receipts, renames, archives, forks, deletions};
  }
  lookup(request: AgentCreateBoundRequest): AgentCreateBoundProof | undefined {
    return this.receipts(request.binding.resourceId, request.operationId).creations.lookup(request);
  }
  status(request: AgentCreateBoundRequest) {
    return this.receipts(request.binding.resourceId, request.operationId).creations.status(request);
  }
  renameLookup(request: AgentRenameRequest) {
    return this.receipts(undefined, request.operationId).renames.lookup(request);
  }
  renameStatus(request: AgentRenameRequest, resourceId?: string) {
    return this.receipts(resourceId, request.operationId).renames.status(request);
  }
  archiveLookup(request: AgentArchiveRequest) {
    return this.receipts(undefined, request.operationId).archives.lookup(request);
  }
  archiveStatus(request: AgentArchiveRequest, resourceId?: string) {
    return this.receipts(resourceId, request.operationId).archives.status(request);
  }
  forkStatus(request: AgentForkRequest) {
    return this.receipts(request.binding.resourceId, request.childId).forks.status(request);
  }
  deletionStatus(request: AgentDeletionRequest, resourceId?: string) {
    return this.receipts(resourceId ?? request.binding?.resourceId, request.requestId).deletions.status(request);
  }
  deletionReplay(request: AgentDeletionRequest, options?: AgentDeletionWriteOptions, resourceId?: string): boolean {
    const owner = this.receipts(resourceId ?? request.binding?.resourceId, request.requestId).deletions;
    owner.validateWrite(request, options);
    return owner.replay(request);
  }
}
