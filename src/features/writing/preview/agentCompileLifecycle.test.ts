import { describe, expect, it } from "vitest";
import { agentCompileRemainingMs, isAgentCompileExpired } from "./agentCompileLifecycle";

describe("agentCompileRemainingMs", () => {
  it("uses creation time rather than preview-open time", () => {
    expect(agentCompileRemainingMs({ createdAtUnixSeconds: 100, expiresAfterSeconds: 60 }, 110_000)).toBe(50_000);
  });
  it("clamps already expired results", () => {
    expect(agentCompileRemainingMs({ createdAtUnixSeconds: 100, expiresAfterSeconds: 60 }, 200_000)).toBe(0);
    expect(isAgentCompileExpired({ createdAtUnixSeconds: 100, expiresAfterSeconds: 60 }, 200_000)).toBe(true);
    expect(isAgentCompileExpired({ createdAtUnixSeconds: 100, expiresAfterSeconds: 60 }, 159_000)).toBe(false);
  });
});
