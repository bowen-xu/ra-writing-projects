import { decodeAgentContextState } from "@research-assistant/core/agent";
import type { StructuredStartupImport } from "@research-assistant/core/structured-resources";
import type { AgentContextConfiguration } from "@research-assistant/workbench-preview/agent-context-gateway";

/** Native authority wins even over a damaged cache; deleted conversations are skipped. */
export function importMockStartupContexts(
  records: Map<string, AgentContextConfiguration>,
  contexts: StructuredStartupImport["contexts"],
  exists: (id: string) => boolean,
): void {
  const incoming = contexts.filter(context => !records.has(context.conversationId) && exists(context.conversationId))
    .map(context => {
      try { return {id: context.conversationId, state: decodeAgentContextState(context.state)}; }
      catch { throw new Error(`无法迁移对话 ${context.conversationId} 的旧上下文配置，原配置已保留。`); }
    });
  for (const context of incoming) records.set(context.id, {revision: 1, state: context.state});
}
