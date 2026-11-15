import { describe, expect, it } from "vitest";
import { createAgentConversationProjection, type AgentConversationProjection } from "@research-assistant/core/agent";
import { latestAgentCompileResult } from "./latestAgentCompileResult";

const id = "11111111-1111-4111-8111-111111111111";

describe("latestAgentCompileResult", () => {
  it("ignores unrelated or malformed tool output", () => {
    const projection = createAgentConversationProjection(id);
    expect(latestAgentCompileResult(projection, id)).toBeUndefined();
  });

  it("keeps the last retained PDF when a later Agent compile fails", () => {
    const success = {
      status: "succeeded", resultId: "22222222-2222-4222-8222-222222222222", compileVersion: "22222222-2222-4222-8222-222222222222",
      identity: { conversationId: id, requestId: id, turnId: id, contextSnapshotId: id, manuscriptId: id, leaseId: id, manifestHash: "a".repeat(64) },
      rootPath: "main.tex", exitCode: 0, diagnostics: [], artifacts: { pdf: { byteSize: 1 }, synctex: { byteSize: 1 } }, retained: true, createdAtUnixSeconds: 1, expiresAfterSeconds: 3600,
    };
    const failed = { ...success, status: "failed", resultId: "33333333-3333-4333-8333-333333333333", compileVersion: "33333333-3333-4333-8333-333333333333", exitCode: 1, artifacts: { pdf: false, synctex: false }, retained: false };
    const turn = { itemOrder: ["success", "failed"], items: new Map([
      ["success", { completed: true, interrupted: false, kind: { type: "toolResult", callId: "s", isError: false }, text: JSON.stringify(success) }],
      ["failed", { completed: true, interrupted: false, kind: { type: "toolResult", callId: "f", isError: true }, text: JSON.stringify(failed) }],
    ]) };
    const projection = { ...createAgentConversationProjection(id), turnOrder: [id], turns: new Map([[id, turn]]) } as unknown as AgentConversationProjection;
    expect(latestAgentCompileResult(projection, id, 2_000)?.resultId).toBe(success.resultId);
  });

  it("skips expired retained results when reopening a manuscript", () => {
    const expired = {
      status: "succeeded", resultId: "44444444-4444-4444-8444-444444444444", compileVersion: "44444444-4444-4444-8444-444444444444",
      identity: { conversationId: id, requestId: id, turnId: id, contextSnapshotId: id, manuscriptId: id, leaseId: id, manifestHash: "a".repeat(64) },
      rootPath: "main.tex", exitCode: 0, diagnostics: [], artifacts: { pdf: { byteSize: 1 }, synctex: { byteSize: 1 } }, retained: true, createdAtUnixSeconds: 1, expiresAfterSeconds: 1,
    };
    const turn = { itemOrder: ["expired"], items: new Map([["expired", { completed: true, interrupted: false, kind: { type: "toolResult", callId: "e", isError: false }, text: JSON.stringify(expired) }]]) };
    const projection = { ...createAgentConversationProjection(id), turnOrder: [id], turns: new Map([[id, turn]]) } as unknown as AgentConversationProjection;
    expect(latestAgentCompileResult(projection, id, 2_000)).toBeUndefined();
  });
});
