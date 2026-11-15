// @vitest-environment happy-dom
import {expect, it, vi} from "vitest";
import {decodeWritingCheckpointRecord, type WritingDocumentCheckpoint} from "@research-assistant/writing";
import fixture from "../../../../../../packages/writing/fixtures/document-checkpoint-v1.json";
import receiptFixture from "../../../../../../packages/writing/fixtures/document-checkpoint-editor-receipt-v1.json";
import {memoryWritingRecords, memoryWritingState, registerWritingRecords} from "../../../../../../apps/web/src/app/runtime/testing/memoryWritingRecords";
import {writingFileKey} from "../../../../../../apps/web/src/core/public/writingStorage";
import {createBrowserWritingCheckpointGateway} from "./browserWritingCheckpointGateway";
import {createIndexedPreviewStorage} from "../../../../../../apps/web/src/core/runtime/previewIndexedStorage";
import {configurePreviewDatabase} from "../../../../../../apps/web/src/core/runtime/previewIndexedDatabase";
import {createMemoryPreviewDatabase} from "../../../../../../apps/web/src/app/runtime/testing/memoryPreviewDatabase";
import {storagePersistence} from "../../../../../../apps/web/src/core/runtime/storagePersistence";

const checkpoint = {...fixture, schemaVersion: 1 as const};
const key = writingFileKey(checkpoint.manuscriptId, checkpoint.relativePath);
function setup(beforeCommit?: () => Promise<void>) {
  const state = memoryWritingState(), records = memoryWritingRecords(state, beforeCommit);
  const storage = Object.create(localStorage) as Storage;
  registerWritingRecords(storage, records);
  return {state, records, storage, gateway: createBrowserWritingCheckpointGateway(storage)};
}

it("does not preload checkpoint bodies and reads only the requested project or saved file", async () => {
  const {state, records, storage, gateway} = setup();
  const kv = vi.spyOn(storage, "getItem");
  for (let i = 0; i < 1000; i++) {
    const row = {...checkpoint, manuscriptId: "project-" + i};
    state.stores.get("writingCheckpoints")!.set(writingFileKey(row.manuscriptId, row.relativePath), {revision: 7, checkpoint: row});
  }
  expect(records.reads).toEqual([]);
  expect(await gateway.list("project-5")).toEqual([{revision: 7, checkpoint: {...checkpoint, manuscriptId: "project-5"}}]);
  expect(records.reads).toEqual([{store: "writingCheckpoints", count: 1}]);
  await gateway.save({expectedRevision: null, checkpoint});
  expect(records.reads.at(-1)).toEqual({store: "writingCheckpoints", count: 0});
  expect(kv).not.toHaveBeenCalled();
});

it("preserves revision, full recovery state, original receipt and idempotent retries across owners", async () => {
  const {state, storage, gateway} = setup();
  const input: WritingDocumentCheckpoint = {...receiptFixture, schemaVersion: 1};
  const first = await gateway.save({expectedRevision: null, checkpoint: input});
  const revision = state.checkpointRevision;
  const reopened = createBrowserWritingCheckpointGateway(storage);
  expect(await reopened.list(input.manuscriptId)).toEqual([first]);
  expect(await reopened.save({expectedRevision: null, checkpoint: input})).toEqual(first);
  expect(state.checkpointRevision).toBe(revision);
  await expect(reopened.save({expectedRevision: first.revision, checkpoint: {
    ...input, editorReceipt: {...input.editorReceipt!, text: input.content},
  }})).rejects.toThrow("回执正文与操作结果不匹配");
  expect(await reopened.list(input.manuscriptId)).toEqual([first]);
});

it("retries only unrelated connection revisions without relaxing the file's CAS", async () => {
  let once = true;
  const host = setup(async () => { if (once) { once = false; host.state.checkpointRevision++; } });
  const saved = await host.gateway.save({expectedRevision: null, checkpoint});
  expect(saved.revision).toBe(1);
  expect(host.records.reads).toHaveLength(2);
  await host.gateway.save({expectedRevision: 1, checkpoint: {...checkpoint, version: 4, content: "newer"}});
  await expect(host.gateway.save({expectedRevision: 1, checkpoint: {...checkpoint, version: 5, content: "stale"}}))
    .rejects.toMatchObject({code: "checkpoint_conflict"});
  expect((await host.gateway.list(checkpoint.manuscriptId))[0]?.checkpoint.content).toBe("newer");
});

it("retains durable content on transaction failure and waits for the actual commit receipt", async () => {
  let reject = false, release: (() => void) | undefined;
  const host = setup(async () => {
    if (reject) throw new DOMException("quota", "QuotaExceededError");
    if (release === undefined) await new Promise<void>(resolve => { release = resolve; });
  });
  let completed = false;
  const save = host.gateway.save({expectedRevision: null, checkpoint}).then(row => { completed = true; return row; });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(completed).toBe(false); expect(host.records.pending).toBe(true);
  expect(host.state.stores.get("writingCheckpoints")!.size).toBe(0);
  release!(); const saved = await save;
  reject = true;
  await expect(host.gateway.save({expectedRevision: saved.revision, checkpoint: {...checkpoint, version: 4, content: "unsaved"}})).rejects.toThrow("quota");
  expect(decodeWritingCheckpointRecord(host.state.stores.get("writingCheckpoints")!.get(key))).toEqual(saved);
  reject = false;
  expect((await host.gateway.save({expectedRevision: saved.revision, checkpoint: {...checkpoint, version: 4, content: "retry"}})).revision).toBe(2);
});

it("does not read or rewrite the explicit Storage fixture until used, and never rewrites on list", async () => {
  const values = new Map<string, string>();
  const storage = {getItem: vi.fn(key => values.get(key) ?? null), setItem: vi.fn((key, value) => { values.set(key, value); })} as unknown as Storage;
  const gateway = createBrowserWritingCheckpointGateway(storage);
  expect(storage.getItem).not.toHaveBeenCalled();
  await gateway.save({expectedRevision: null, checkpoint});
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(await createBrowserWritingCheckpointGateway(storage).list(checkpoint.manuscriptId)).toEqual([{revision: 1, checkpoint}]);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
});

it("keeps formal file and recovery CAS domains independent and rejects mixed snapshots", async () => {
  const {records, state, gateway} = setup();
  const files = await records.read([]);
  await gateway.save({expectedRevision: null, checkpoint});
  expect(state.revision).toBe(files.revision);
  await records.commit(files.revision, [{store: "writingSessions", key: "session", value: {}}]);
  expect(state.checkpointRevision).toBe(1);
  await gateway.save({expectedRevision: 1, checkpoint: {...checkpoint, version: 4, content: "later"}});
  expect(state.revision).toBe(1); expect(state.checkpointRevision).toBe(2);
  await expect(records.read([{store: "writingCheckpoints"}, {store: "writingBodies"}])).rejects.toMatchObject({code: "writing_storage_domain_mismatch"});
});

it("rejects a missing project scope before any checkpoint scan", async () => {
  const {records, gateway} = setup();
  await expect(gateway.list("")).rejects.toMatchObject({code: "writing_checkpoint_scope_invalid"});
  expect(records.reads).toEqual([]);
});

it("serializes concurrent recovery records without replacing another file's checkpoint", async () => {
  const {state, gateway} = setup();
  await Promise.all([gateway.save({expectedRevision: null, checkpoint}),
    gateway.save({expectedRevision: null, checkpoint: {...checkpoint, relativePath: "other.tex"}})]);
  const restored = await gateway.list(checkpoint.manuscriptId);
  expect(restored.map(row => row.revision)).toEqual([1, 1]);
  expect(restored.map(row => row.checkpoint.relativePath)).toEqual(["other.tex", checkpoint.relativePath]);
  expect(state.revision).toBe(0);
});

it("does not exhaust CAS retries when a project recovers many independent source files together", async () => {
  const {storage, gateway} = setup(async () => { await Promise.resolve(); });
  const reopened = createBrowserWritingCheckpointGateway(storage);
  await Promise.all(Array.from({length: 12}, (_, i) => (i % 2 ? gateway : reopened).save({expectedRevision: null,
    checkpoint: {...checkpoint, relativePath: `source-${i}.tex`}})));
  expect(await gateway.list(checkpoint.manuscriptId)).toHaveLength(12);
});

it("flushes recovery writes, clears only the selected preview, and closes old checkpoint owners on reset", async () => {
  configurePreviewDatabase(createMemoryPreviewDatabase().open);
  const storage = await createIndexedPreviewStorage("checkpoint-reset:"), other = await createIndexedPreviewStorage("checkpoint-other:");
  const gateway = createBrowserWritingCheckpointGateway(storage), untouched = createBrowserWritingCheckpointGateway(other);
  await gateway.save({expectedRevision: null, checkpoint});
  await untouched.save({expectedRevision: null, checkpoint});
  await storagePersistence(storage)!.reset();
  await expect(gateway.list(checkpoint.manuscriptId)).rejects.toThrow("writing_storage_closed");
  expect(await createBrowserWritingCheckpointGateway(await createIndexedPreviewStorage("checkpoint-reset:")).list(checkpoint.manuscriptId)).toEqual([]);
  expect(await untouched.list(checkpoint.manuscriptId)).toEqual([{revision: 1, checkpoint}]);
});
