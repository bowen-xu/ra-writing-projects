import { describe, expect, it, vi } from "vitest";
import { readAgentCompilePdfSource } from "./agentCompilePdfSource";

const id = "11111111-1111-4111-8111-111111111111";
const result = { status: "succeeded" as const, resultId: id, compileVersion: id, rootPath: "main.tex", exitCode: 0,
  diagnostics: [], artifacts: { pdf: true, synctex: true }, retained: true, createdAtUnixSeconds: 1_800_000_000, expiresAfterSeconds: 3600,
  identity: { conversationId: id, requestId: id, turnId: id, contextSnapshotId: id, manuscriptId: id, leaseId: id, manifestHash: "a".repeat(64) } };

describe("readAgentCompilePdfSource", () => {
  it("binds the shared viewer source to the manuscript and compile result", async () => {
    const readPdf = vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    const source = await readAgentCompilePdfSource({ readPdf, readSynctex: vi.fn(), forwardSynctex: vi.fn(), inverseSynctex: vi.fn() }, result);
    expect(source.key).toBe(`${id}:agent-compile:${id}`);
    expect(source.revision).toBe(id);
    expect(source.bytes).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(readPdf).toHaveBeenCalledWith(result);
  });
});
