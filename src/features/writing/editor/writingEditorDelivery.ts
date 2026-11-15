import type { AgentApplicationScope } from "@research-assistant/core/agent";
import type { AgentProposalGateway } from "@research-assistant/data/agent";
import type { WritingCheckpointPersistence } from "../persistence/WritingCheckpointPersistence";
import type { WritingFileSessions } from "./writingFileSessions";
import type { WritingEditorDelivery } from "./editorApplication";
import type { WritingDocumentOperation } from "@research-assistant/writing";

type Source = (scope: AgentApplicationScope, path: string) => Promise<Omit<WritingDocumentOperation, "resultSha256">>;

/** Native journals govern admission; immutable proposals supply delivery provenance only. */
export function createWritingEditorDelivery(files: WritingFileSessions, checkpoints: WritingCheckpointPersistence,
  proposals: Pick<AgentProposalGateway, "review">): WritingEditorDelivery {
  async function source(scope: AgentApplicationScope, path: string) {
    const proposal = await proposals.review({ manuscriptId: scope.manuscriptId, conversationId: scope.conversationId, proposalId: scope.proposalId });
    const binding = proposal.review.binding.scope;
    const change = proposal.review.changes.find((item) => item.path === path);
    if (proposal.proposalId !== scope.proposalId || binding.manuscriptId !== scope.manuscriptId
      || binding.conversationId !== scope.conversationId || !binding.requestId || !change
      || change.kind !== "modified" || !change.before || !change.after) throw new Error("文件修改来源与应用记录不一致");
    return { operationId: scope.operationId, conversationId: binding.conversationId, requestId: binding.requestId };
  }
  return checkpointedDelivery(files, checkpoints, source);
}

/** Existing file credentials supply provenance for Undo and compensation. Native
 * prepare/confirm still authorize each exact operation and current version. */
export function createWritingFileOperationDelivery(files: WritingFileSessions, checkpoints: WritingCheckpointPersistence,
  original: AgentApplicationScope): WritingEditorDelivery {
  const owner = { ...original };
  return checkpointedDelivery(files, checkpoints, async (scope, path) => {
    if (scope.manuscriptId !== owner.manuscriptId || scope.conversationId !== owner.conversationId
      || scope.proposalId !== owner.proposalId) throw new Error("文件操作来源与原应用不一致");
    const source = files.get({ manuscriptId: owner.manuscriptId, relativePath: path })?.readOperations()
      .find(operation => operation.operationId === owner.operationId);
    if (!source || source.conversationId !== owner.conversationId) throw new Error("文件操作缺少可靠的原应用来源");
    return { operationId: scope.operationId, conversationId: source.conversationId, requestId: source.requestId };
  });
}

function checkpointedDelivery(files: WritingFileSessions, checkpoints: WritingCheckpointPersistence,
  source: Source): WritingEditorDelivery {
  return {
    async apply(scope, path, port, edit) {
      const identity = { manuscriptId: scope.manuscriptId, relativePath: path };
      const provenance = await source(scope, path);
      if (files.get(identity)?.applicationPort !== port) return { status: "unavailable" };
      return checkpoints.applyEditorAgent(identity, provenance, edit);
    },
    async settle(scope, path, port) {
      const identity = { manuscriptId: scope.manuscriptId, relativePath: path };
      const provenance = await source(scope, path);
      if (files.get(identity)?.applicationPort !== port) return false;
      return checkpoints.settleEditorAgent(identity, provenance);
    },
  };
}
