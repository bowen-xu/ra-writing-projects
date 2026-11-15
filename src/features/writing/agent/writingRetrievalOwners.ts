import type { PendingConceptRetrieval } from "@research-assistant/workbench-sdk/concept-retrieval";
import type { WritingAgentSubmitOptions } from "@research-assistant/workbench-sdk/agent-presentation";
import type {WritingDraftReceipt} from "@research-assistant/workbench-sdk/agent-writing";

export type WritingPendingRetrieval = PendingConceptRetrieval & {
  readonly requestId: string;
  readonly submissionRequestId?: string;
  readonly options: WritingAgentSubmitOptions;
  readonly receipt?: WritingDraftReceipt;
  readonly queued?: { readonly inputId: string; readonly revision: number };
};

export type WritingRetrievalOwner = {
  readonly key: string;
  pending: WritingPendingRetrieval | undefined;
  views: number;
  readonly listeners: Set<() => void>;
};

const writingRetrievalOwners = new Map<string, WritingRetrievalOwner>();

function writingRetrievalOwnerKey(manuscriptId: string | undefined, conversationId: string | null, runtimeId?: string): string {
  return JSON.stringify([runtimeId ?? "desktop", manuscriptId?.toLowerCase() ?? null, conversationId?.toLowerCase() ?? null]);
}

function getWritingRetrievalOwner(manuscriptId: string | undefined, conversationId: string | null, runtimeId?: string): WritingRetrievalOwner {
  const key = writingRetrievalOwnerKey(manuscriptId, conversationId, runtimeId);
  const existing = writingRetrievalOwners.get(key);
  if (existing) return existing;
  const owner: WritingRetrievalOwner = { key, pending: undefined, views: 0, listeners: new Set() };
  writingRetrievalOwners.set(key, owner);
  return owner;
}

function publishWritingRetrievalOwner(owner: WritingRetrievalOwner): void {
  for (const listener of owner.listeners) listener();
}

function collectWritingRetrievalOwner(owner: WritingRetrievalOwner): void {
  if (owner.views !== 0 || owner.pending !== undefined || writingRetrievalOwners.get(owner.key) !== owner) return;
  writingRetrievalOwners.delete(owner.key);
}

export function acquireWritingRetrievalOwner(manuscriptId: string | undefined, conversationId: string | null, runtimeId?: string): { owner: WritingRetrievalOwner; release: () => void } {
  const owner = getWritingRetrievalOwner(manuscriptId, conversationId, runtimeId);
  owner.views += 1;
  let released = false;
  return {
    owner,
    release: () => {
      if (released) return;
      released = true;
      owner.views = Math.max(0, owner.views - 1);
      collectWritingRetrievalOwner(owner);
    },
  };
}

export function setWritingRetrievalOwner(owner: WritingRetrievalOwner, pending: WritingPendingRetrieval | undefined): void {
  owner.pending = pending;
  publishWritingRetrievalOwner(owner);
}

export function resetWritingRetrievalOwnersForTests(): void {
  writingRetrievalOwners.clear();
}
