import { AgentWorkspaceDecodeError, decodeAgentUndoRequest, type AgentApplicationScope } from "@research-assistant/core/agent";
import type { createAgentUndoGateway } from "@research-assistant/data/agent";
import type { createWritingEditorUndo } from "../editor/editorUndo";
import type { WritingApplicationLease } from "./writingProposalApplication";
import { recoverWritingApplication } from "./writingApplicationRecovery";

/** Reuse the lease-protected recovery path; no pending writes are resumed. */
export function recoverWritingUndo(
  original: AgentApplicationScope, undoId: string, path: string,
  gateway: ReturnType<typeof createAgentUndoGateway>,
  editor: ReturnType<typeof createWritingEditorUndo>,
  acquire: (scope: AgentApplicationScope) => Promise<WritingApplicationLease | null>,
) {
  const identity = decodeAgentUndoRequest({ scope: original, undoId, command: { action: "read" } });
  const scope = { ...identity.scope, operationId: identity.undoId };
  return recoverWritingApplication(scope, path, {
    async execute(request) {
      if (request.action !== "read" && request.action !== "reconcileDisk") throw new AgentWorkspaceDecodeError();
      const response = await gateway.execute({ ...identity, command: request.action === "read"
        ? { action: "read" } : { action: "reconcileDisk", path: request.path } });
      if (!response.result) throw new AgentWorkspaceDecodeError();
      return response.result;
    },
  }, { apply: (_scope, path) => editor.apply(path), recover: (_scope, path) => editor.recover(path) }, () => acquire(identity.scope));
}
