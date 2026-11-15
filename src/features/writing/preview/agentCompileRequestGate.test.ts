import { describe, expect, it } from "vitest";
import { createAgentCompileRequestGate } from "./agentCompileRequestGate";

describe("Agent compile request fencing", () => {
  it("invalidates late PDF and SyncTeX responses when the compile changes", () => {
    const gate = createAgentCompileRequestGate();
    const oldRequest = gate.begin();
    const newerRequest = gate.begin();
    expect(gate.isCurrent(oldRequest)).toBe(false);
    expect(gate.isCurrent(newerRequest)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(newerRequest)).toBe(false);
  });
});
