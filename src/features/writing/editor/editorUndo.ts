import { AgentWorkspaceDecodeError, decodeAgentUndoRequest,
  type AgentApplicationScope, type AgentEditorSessionPort, type AgentUndoCommand } from "@research-assistant/core/agent";
import type { createAgentUndoGateway } from "@research-assistant/data/agent";
import { createWritingEditorApplication, type WritingEditorDelivery } from "./editorApplication";

/** One coordinator per independent undo. The host owns complete manuscript/save
 * exclusion and retains this instance for retries. Never create an original apply
 * operation to recover undo; both use the same live-port transaction protocol. */
export function createWritingEditorUndo(
  gateway: ReturnType<typeof createAgentUndoGateway>,
  original: AgentApplicationScope,
  undoId: string,
  resolve: (scope: AgentApplicationScope, path: string) => AgentEditorSessionPort | null,
  delivery?: WritingEditorDelivery,
) {
  const identity = decodeAgentUndoRequest({ scope: original, undoId, command: { action: "read" } });
  const scope = { ...identity.scope, operationId: identity.undoId };
  const application = createWritingEditorApplication({
    async execute(request) {
      for (const key of ["conversationId", "manuscriptId", "proposalId", "operationId"] as const) {
        if (request.scope[key] !== scope[key]) throw new AgentWorkspaceDecodeError();
      }
      let command: AgentUndoCommand;
      switch (request.action) {
        case "read": command = { action: "read" }; break;
        case "prepareEditor": command = { action: "prepareEditor", current: request.current }; break;
        case "confirmEditor": command = { action: "confirmEditor", actual: request.actual }; break;
        case "deferEditor": command = { action: "defer" }; break;
        default: throw new AgentWorkspaceDecodeError();
      }
      const response = await gateway.execute({ scope: identity.scope, undoId: identity.undoId, command });
      if (!response.result) throw new AgentWorkspaceDecodeError();
      return response.result;
    },
  }, resolve, delivery);
  return {
    apply(path: string) { return application.apply(scope, path); },
    recover(path: string) { return application.recover(scope, path); },
  };
}
