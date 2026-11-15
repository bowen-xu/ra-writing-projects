import type { AgentCompileResult, AgentConversationProjection } from "@research-assistant/core/agent";
import { decodeAgentCompileResult } from "@research-assistant/core/agent";
import { isAgentCompileExpired } from "./agentCompileLifecycle";

/** Read-only projection adapter. Tool output is untrusted UI data and never grants execution or file access. */
export function latestAgentCompileResult(
  projection: AgentConversationProjection | null,
  manuscriptId: string,
  nowMs = Date.now(),
): AgentCompileResult | undefined {
  if (!projection) return undefined;
  let latest: AgentCompileResult | undefined;
  for (const [, turn] of projection.turns) {
    for (const itemId of turn.itemOrder) {
      const item = turn.items.get(itemId);
      if (!item || !item.completed || item.kind.type !== "toolResult" || item.kind.isError) continue;
      try {
        const value = JSON.parse(item.text) as unknown;
        const result = decodeAgentCompileResult(value);
        if (result.identity.conversationId !== projection.conversationId || result.identity.manuscriptId !== manuscriptId.toLowerCase()) continue;
        if (isAgentCompileExpired(result, nowMs)) continue;
        // A failed Agent compile is still useful as a diagnostic, but it must
        // not replace the last readable approved-copy PDF. The preview host
        // keeps the formal PDF (or the previous Agent PDF) while the turn's
        // diagnostics remain visible in the conversation. Only a retained,
        // successful PDF is a valid viewer source.
        if (result.status !== "succeeded" || !result.retained || !result.artifacts.pdf) continue;
        // Projection insertion order is the durable journal order. UUID
        // ordering is unrelated to compile chronology.
        latest = result;
      } catch {
        // Other tool results are expected; they are not compile artifacts.
      }
    }
  }
  return latest;
}
