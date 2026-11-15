import { createHash } from "node:crypto";
import { undo } from "@codemirror/commands";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath, type WritingCheckpointRecord, type WritingDocumentOperation } from "@research-assistant/writing";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";

const identity = { manuscriptId: "manuscript", relativePath: "main.tex" };
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function operation(id: string, text: string): WritingDocumentOperation {
  return { operationId: id, conversationId: `conversation-${id}`, requestId: `request-${id}`, resultSha256: hash(text) };
}
async function setup(storage = new Map<string, WritingCheckpointRecord>(), hashContent = async (text: string) => hash(text)) {
  const files = new WritingFileSessions(), adapter = createMemoryWritingCheckpointGateway(storage);
  const gateway = { list: adapter.list, save: vi.fn(adapter.save) };
  const owner = new WritingCheckpointPersistence(files, gateway, vi.fn(), hashContent);
  const disconnect = owner.connect();
  const session = await owner.open(identity.manuscriptId, { relativePath: parseManuscriptPath(identity.relativePath), content: "original", sha256: hash("original") });
  return { owner, session, storage, gateway, disconnect };
}
it("durably accepts subsequent conversations against the latest working version and publishes provenance with the text", async () => {
  const host = await setup();
  const receipts: WritingDocumentOperation[][] = [];
  host.session.subscribe(() => receipts.push([...host.session.readOperations()]));
  const first = operation("first", "first proposal"), second = operation("second", "second proposal");
  expect(await host.owner.applyAgent(identity, first, 0, "first proposal")).toBe("applied");
  expect(receipts[0]).toEqual([first]);
  expect(await host.owner.applyAgent(identity, second, host.session.read().version, "second proposal")).toBe("applied");
  expect(host.session.read()).toMatchObject({ content: "second proposal", reviewBaseline: "original" });
  expect([...host.storage.values()][0]?.checkpoint.operations).toEqual([first, second]);
  host.disconnect();
});
it.each(["keep", "undo"] as const)("never reinstalls a delivered operation after %s and a fresh process restores its checkpoint", async (action) => {
  const host = await setup(), source = operation("agent", "proposal");
  await host.owner.applyAgent(identity, source, 0, "proposal");
  host.session.resolveAll(action); await host.owner.flushAll();
  const before = host.session.read(); host.disconnect();
  const restored = await setup(host.storage);
  expect(await restored.owner.applyAgent(identity, source, 0, "proposal")).toBe("duplicate");
  expect(restored.session.read()).toEqual(before);
  expect(restored.session.pending).toBe(false);
  restored.disconnect();
});
it("retains operation credentials when editor history reverses the entire Agent modification", async () => {
  const host = await setup(), source = operation("agent", "proposal");
  await host.owner.applyAgent(identity, source, 0, "proposal");
  expect(undo({ state: host.session.state, dispatch: (transaction) => host.session.accept([transaction]) })).toBe(true);
  await host.owner.flushAll(); host.disconnect();
  const restored = await setup(host.storage);
  expect(await restored.owner.applyAgent(identity, source, 0, "proposal")).toBe("duplicate");
  expect(restored.session.read().content).toBe("original");
  restored.disconnect();
});
it("retries an uncertain checkpoint receipt without installing again or losing later user edits", async () => {
  const host = await setup(), source = operation("agent", "proposal"), save = host.gateway.save.getMockImplementation()!;
  // Both the immediate listener flush and the explicit delivery flush lose their acknowledgement.
  const loseReceipt = async (write: Parameters<typeof save>[0]) => { await save(write); throw new Error("receipt lost"); };
  host.gateway.save.mockImplementationOnce(loseReceipt).mockImplementationOnce(loseReceipt);
  await expect(host.owner.applyAgent(identity, source, 0, "proposal")).rejects.toThrow("receipt lost");
  host.session.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" });
  const version = host.session.read().version;
  expect(await host.owner.applyAgent(identity, source, 0, "proposal")).toBe("duplicate");
  expect(host.session.read()).toMatchObject({ content: "manual proposal", reviewBaseline: "original", version });
  expect([...host.storage.values()][0]?.checkpoint).toMatchObject({ content: "manual proposal", operations: [source] });
  host.disconnect();
});
it("rechecks the current file version after asynchronous payload hashing instead of overwriting new input", async () => {
  let release!: () => void;
  const host = await setup(new Map<string, WritingCheckpointRecord>(), async (text) => { await new Promise<void>((resolve) => { release = resolve; }); return hash(text); });
  const pending = host.owner.applyAgent(identity, operation("agent", "proposal"), 0, "proposal");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  host.session.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" });
  release(); expect(await pending).toBe("conflict");
  expect(host.session.read().content).toBe("manual original");
  expect(host.session.readOperations()).toEqual([]);
  host.disconnect();
});
it("rejects a changed payload or source identity for the same operation, and validates metadata before installing text", async () => {
  const host = await setup(), source = operation("agent", "proposal");
  expect(await host.owner.applyAgent(identity, source, 0, "wrong bytes")).toBe("conflict");
  await expect(host.owner.applyAgent(identity, { ...source, requestId: "" }, 0, "proposal")).rejects.toThrow("无效");
  expect(host.session.read().content).toBe("original");
  await host.owner.applyAgent(identity, source, 0, "proposal");
  expect(await host.owner.applyAgent(identity, { ...source, conversationId: "other" }, 0, "proposal")).toBe("conflict");
  expect(host.session.readOperations()).toEqual([source]);
  host.disconnect();
});
it("persists a no-op delivery credential without creating an extra editing history item", async () => {
  const host = await setup(), source = operation("noop", "original");
  expect(await host.owner.applyAgent(identity, source, 0, "original")).toBe("applied");
  expect(host.session.read().version).toBe(0);
  expect([...host.storage.values()][0]?.checkpoint.operations).toEqual([source]);
  expect(undo({ state: host.session.state, dispatch: (transaction) => host.session.accept([transaction]) })).toBe(false);
  host.disconnect();
  const restored = await setup(host.storage);
  expect(await restored.owner.applyAgent(identity, source, 0, "original")).toBe("duplicate");
  restored.disconnect();
});
