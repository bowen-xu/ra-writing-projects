import { expect, it } from "vitest";
import { createWritingCompactionReceiptStore } from "./writingCompactionReceipt";
import {agentWritingCompactionStartRequest, type AgentWritingCompactionPreview} from "@research-assistant/core/agent";

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const receipt = { manuscriptId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222", requestId: "33333333-3333-4333-8333-333333333333" };
const other = { ...receipt, requestId: "44444444-4444-4444-8444-444444444444" };

it("restores only the original locator across owners, without source text or a guessed history fence", () => {
  const storage = memory(), first = createWritingCompactionReceiptStore(storage);
  first.save(receipt);
  const reopened = createWritingCompactionReceiptStore(storage);
  expect(reopened.read(receipt)).toEqual(receipt);
  expect(JSON.parse([...storage.data.values()][0]!)).toEqual({ schemaVersion: 1, ...receipt });
  expect(() => reopened.save(other)).toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  reopened.clear(other);
  expect(reopened.read(receipt)).toEqual(receipt);
  reopened.clear(receipt);
  reopened.save(other);
  expect(reopened.read(receipt)).toEqual(other);
});

it("isolates manuscript and conversation scopes and retains malformed recovery data for diagnosis", () => {
  const storage = memory(), store = createWritingCompactionReceiptStore(storage);
  store.save(receipt);
  expect(store.read({ ...receipt, conversationId: other.requestId })).toBeNull();
  expect(store.read({ ...receipt, manuscriptId: other.requestId })).toBeNull();
  const key = [...storage.data.keys()][0]!;
  storage.setItem(key, JSON.stringify({ schemaVersion: 1, ...receipt, requestId: "invalid" }));
  expect(() => store.read(receipt)).toThrow("COMPACTION_RECOVERY_RECEIPT_INVALID");
  expect(storage.getItem(key)).toContain("invalid");
});

it("preserves the queued I and original execution envelope against a same-R legacy overwrite", () => {
  const storage = memory(), store = createWritingCompactionReceiptStore(storage);
  const queued = {...receipt, inputId: other.requestId, queued: {prepare: null, settle: null}};
  store.save(queued);
  expect(() => store.save(receipt)).toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  expect(() => store.save({...queued, inputId: crypto.randomUUID()})).toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  expect(store.read(receipt)).toEqual(queued);
  expect(JSON.parse([...storage.data.values()][0]!).schemaVersion).toBe(2);
});
function manual() {
  const result: AgentWritingCompactionPreview = {expectedRevision: 7, preview: {schemaVersion: 1, ...receipt, turnId: other.requestId, contextSnapshotId: other.requestId,
    input: {text: "/compact", model: {providerId: "fixture", modelId: "original", revision: null}, reasoningEffort: null,
      context: [{sourceId: "file", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: JSON.stringify({manuscriptId: receipt.manuscriptId}), text: "source"}]}}};
  return {...receipt, manual: {prepare: {expectedRevision: 7, request: {conversationId: receipt.conversationId, requestId: receipt.requestId, text: "/compact",
    context: {manuscriptId: receipt.manuscriptId, files: []}}}, result, knownRejected: false, rejection: null,
    draftAcknowledgment: {schemaVersion: 1 as const, originKey: JSON.stringify(["manuscript", receipt.manuscriptId, receipt.conversationId]), revision: other.requestId}, start: null}};
}
it("persists v4 draft provenance and exact known start, rejecting changed tokens, W or a downgrade of the known result", () => {
  const storage = memory(), store = createWritingCompactionReceiptStore(storage), value = manual(); store.save(value);
  const start = {request: agentWritingCompactionStartRequest(value.manual.result), result: {schemaVersion: 1 as const, conversationId: receipt.conversationId,
    requestId: receipt.requestId, turnId: other.requestId, alreadyStarted: false, outcome: null}};
  const committed = {...value, manual: {...value.manual, start}}; store.save(committed);
  expect(JSON.parse([...storage.data.values()][0]!).schemaVersion).toBe(4);
  expect(store.read(receipt)).toMatchObject(committed);
  expect(() => store.save({...committed, manual: {...committed.manual, draftAcknowledgment: {...committed.manual.draftAcknowledgment, revision: crypto.randomUUID()}}})).toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  expect(() => store.save({...committed, manual: {...committed.manual, start: {...start, result: null}}})).toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  expect(() => store.save({...committed, manual: {...committed.manual, start: {...start, request: {...start.request, expectedRevision: 8}}}})).toThrow("COMPACTION_PREPARATION_SCOPE_MISMATCH");
});
it("never attaches a current draft token to a v3 preparation and rejects foreign draft or start identities", () => {
  const storage = memory(), store = createWritingCompactionReceiptStore(storage), value = manual();
  const {draftAcknowledgment: _token, start: _start, ...legacy} = value.manual;
  storage.setItem(`research-assistant:writing-compaction-receipt:v1:${receipt.manuscriptId}:${receipt.conversationId}`, JSON.stringify({schemaVersion: 3, ...receipt, manual: legacy}));
  expect(store.read(receipt)).toMatchObject({manual: {draftAcknowledgment: null, start: null}});
  expect(() => store.save(value)).toThrow("COMPACTION_RECOVERY_RECEIPT_PENDING");
  const another = createWritingCompactionReceiptStore(memory());
  expect(() => another.save({...value, manual: {...value.manual, draftAcknowledgment: {...value.manual.draftAcknowledgment,
    originKey: JSON.stringify(["manuscript", other.requestId, receipt.conversationId])}}})).toThrow("WRITING_PREPARE_DRAFT_ACK_SCOPE_MISMATCH");
});
