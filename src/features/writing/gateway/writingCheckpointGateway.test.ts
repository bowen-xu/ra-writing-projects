import { expect, it } from "vitest";
import type { WritingCheckpointRecord } from "@research-assistant/writing";
import fixture from "../../../../../../packages/writing/fixtures/document-checkpoint-v1.json";
import receiptFixture from "../../../../../../packages/writing/fixtures/document-checkpoint-editor-receipt-v1.json";
import { createMemoryWritingCheckpointGateway } from "./writingCheckpointGateway";

it("restores the original receipt even when the current text and baseline have changed", async () => {
  const storage = new Map<string, WritingCheckpointRecord>();
  const checkpoint = { ...receiptFixture, schemaVersion: 1 as const };
  await createMemoryWritingCheckpointGateway(storage).save({ expectedRevision: null, checkpoint });
  const [restored] = await createMemoryWritingCheckpointGateway(storage).list(checkpoint.manuscriptId);
  expect(restored?.checkpoint).toEqual(checkpoint);
  expect(restored?.checkpoint.editorReceipt?.text).not.toBe(checkpoint.content);
});

it("rejects receipt text that disagrees with the original operation hash without persisting it", async () => {
  const storage = new Map<string, WritingCheckpointRecord>();
  const gateway = createMemoryWritingCheckpointGateway(storage);
  const checkpoint = { ...receiptFixture, schemaVersion: 1 as const };
  const original = await gateway.save({ expectedRevision: null, checkpoint });
  await expect(gateway.save({ expectedRevision: original.revision, checkpoint: {
    ...checkpoint, editorReceipt: { ...checkpoint.editorReceipt, text: checkpoint.content },
  } })).rejects.toThrow("回执正文与操作结果不匹配");
  expect(await gateway.list(checkpoint.manuscriptId)).toEqual([original]);
});

it("retains mock persistence across gateway recreation without sharing mutable records", async () => {
  const storage = new Map<string, WritingCheckpointRecord>();
  const first = createMemoryWritingCheckpointGateway(storage);
  const checkpoint = { ...fixture, operations: fixture.operations.map((operation) => ({ ...operation })), schemaVersion: 1 as const };
  await first.save({ expectedRevision: null, checkpoint });
  const second = createMemoryWritingCheckpointGateway(storage);
  const [restored] = await second.list(checkpoint.manuscriptId);
  expect(restored?.checkpoint).toEqual(checkpoint);
  checkpoint.operations.pop();
  expect((await second.list(checkpoint.manuscriptId))[0]?.checkpoint.operations).toHaveLength(1);
  await expect(second.save({ expectedRevision: 0, checkpoint })).rejects.toThrow();
});
