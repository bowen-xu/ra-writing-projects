import type { AgentCompileResult } from "@research-assistant/core/agent";

export function agentCompileRemainingMs(result: Pick<AgentCompileResult, "createdAtUnixSeconds" | "expiresAfterSeconds">, nowMs = Date.now()): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  return Math.max(0, (result.createdAtUnixSeconds + result.expiresAfterSeconds - nowSeconds) * 1000);
}

export function isAgentCompileExpired(result: Pick<AgentCompileResult, "createdAtUnixSeconds" | "expiresAfterSeconds">, nowMs = Date.now()): boolean {
  return agentCompileRemainingMs(result, nowMs) === 0;
}
