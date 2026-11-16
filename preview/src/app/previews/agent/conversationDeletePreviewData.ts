import { decodeAgentDeletionWriteOptions, type AgentConversationBinding, type AgentConversationSummary, type AgentDeletionRequest } from "@research-assistant/core/agent";
import type { AgentArchiveGateway, AgentCatalogGateway, AgentConversationExportGateway, AgentDeletionGateway, AgentMetadataGateway, AgentSearchGateway } from "@research-assistant/data/agent";
import { MockRenameReceipts } from "@research-assistant/workbench-preview/mock-rename-receipts";
import { MockArchiveReceipts } from "@research-assistant/workbench-preview/mock-archive-receipts";
import { MockDeletionReceipts } from "@research-assistant/workbench-preview/mock-deletion-receipts";
import type { ConversationDeleteConfirmationPreferences } from "@research-assistant/workbench-preview/conversation-delete-dialog";
import { createMockAgentRecoveryStorage } from "../../runtime/mock/MockAgentRecoveryStorage";

export const conversationDeleteScenarios = [
  { id: "success", label: "正常删除", description: "确认后移除对话，显示成功通知。" },
  { id: "branchHistory", label: "有分支引用", description: "普通删除被保留，可进入强制删除的二次确认。" },
  { id: "proposalApplications", label: "有关联修改记录", description: "模拟旧版本的保留响应；强制删除仍保留文件修改与恢复记录。" },
  { id: "executionWorkspace", label: "有执行副本", description: "普通删除保留执行副本；强制删除需要再次确认。" },
  { id: "busy", label: "任务仍在运行", description: "删除失败并提示先停止任务，对话仍在列表中。" },
  { id: "unavailable", label: "首次失败，重试成功", description: "首次结果不明，保留弹窗；重试相同请求后成功。" },
  { id: "conflict", label: "对话状态已变化", description: "拒绝删除，提示关闭弹窗并刷新列表后重新确认。" },
  { id: "sqlUnknown", label: "SQL 提交结果未知", description: "显示原请求的存储诊断；重试保留同一请求身份。" },
  { id: "workspacePartial", label: "文件清理后 SQL 拒绝", description: "普通删除转入强制确认；文件清理已完成，元数据尚未删除。" },
  { id: "workspaceUnknown", label: "文件清理结果未知", description: "普通删除转入强制确认；保留原请求核对文件清理，不冒充 SQL 提交未知。" },
  { id: "committedAckLost", label: "删除成功但回执丢失", description: "关闭弹窗后原行消失，仍可从待核对入口读取原证明并完成本机收尾。" },
  { id: "recoverySaveFailure", label: "恢复记录首次保存失败", description: "首次不发送删除；先修复本机记录，再显式继续原请求。" },
] as const;
export type ConversationDeleteScenario = typeof conversationDeleteScenarios[number]["id"];

export const conversationDeletePreviewBinding: AgentConversationBinding = {
  kind: "manuscript", resourceId: "00000000-0000-4000-8000-000000000100",
};
const titles = ["完善摘要和研究问题", "对照文献补充相关工作", "讨论方法与实验设计"];

/** Memory-only adapters: no native IPC, real files, model calls, or application preferences. */
export function createConversationDeletePreviewData(scenario: ConversationDeleteScenario, delayMs = 650) {
  let failRecoverySave = scenario === "recoverySaveFailure";
  const recoveryStorage = createMockAgentRecoveryStorage("conversation-delete", () => {
    if (failRecoverySave) {failRecoverySave = false; throw new DOMException("Synthetic storage failure", "QuotaExceededError");}
  });
  let conversations: AgentConversationSummary[] = titles.map((title, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`, title, archived: true, durableCount: 12,
    createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z",
  }));
  const firstConversation = conversations[0]!;
  const attempts: AgentDeletionRequest[] = [];
  const receipts: MockDeletionReceipts = new MockDeletionReceipts(() => renames.epochId(), id => renames.has(id) || archiveReceipts.has(id));
  const renames: MockRenameReceipts = new MockRenameReceipts(id => archiveReceipts.has(id) || receipts.has(id));
  const archiveReceipts = new MockArchiveReceipts(() => renames.epochId(), id => renames.has(id) || receipts.has(id));
  let skipConfirmation = false;
  let skipForceConfirmation = false;
  function read(id: string): AgentConversationSummary {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) throw "notFound";
    return conversation;
  }
  const catalog: AgentCatalogGateway = {
    async list(request) { return { schemaVersion: 1, conversations: conversations.filter((item) => item.archived === request.archived), next: null }; },
    async rename(request) {
      return renames.apply(request, frozen => {
        const original = read(frozen.id);
        if (original.title !== frozen.expectedTitle) throw "conflict";
        const updated = { ...original, title: frozen.title.trim() };
        conversations = conversations.map((item) => item.id === updated.id ? updated : item);
      });
    },
    async renameStatus(request) { return renames.status(request); },
  };
  const archives: AgentArchiveGateway = {
    async setArchived(request) {
      return archiveReceipts.apply(request, frozen => {
        const current = read(frozen.id);
        if (frozen.archived && current.durableCount !== frozen.expectedWatermark) throw "conflict";
        const updated = { ...current, archived: frozen.archived };
        conversations = conversations.map((item) => item.id === updated.id ? updated : item);
      });
    },
    async archiveStatus(request) { return archiveReceipts.status(request); },
  };
  const metadata: AgentMetadataGateway = { async read(request) { return read(request.id); } };
  const search: AgentSearchGateway = {
    async search(request) {
      return { schemaVersion: 1, next: null, hits: conversations
        .filter((item) => item.archived === request.scope.archived && item.title.includes(request.term))
        .map((conversation) => ({ conversation, excerpt: conversation.title, itemId: null, turnId: null, startSeq: null, completed: true })) };
    },
  };
  const deletions: AgentDeletionGateway = {
    async status(request) { return receipts.status(request); },
    async delete(input, options) {
      const precondition = options === undefined ? undefined : decodeAgentDeletionWriteOptions(options);
      const request = receipts.validateWrite(input, precondition);
      attempts.push(request);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      receipts.validateWrite(request, precondition);
      if (!receipts.replay(request)) {
        const conversation = read(request.conversationId);
        if (!conversation.archived) throw "notArchived";
        if (conversation.title !== request.expectedTitle || conversation.durableCount !== request.expectedDurableCount) throw "conflict";
        if (scenario === "busy" || scenario === "conflict") throw scenario;
        if (["branchHistory", "proposalApplications", "executionWorkspace"].includes(scenario) && !request.force) throw scenario;
        if (scenario === "unavailable" && attempts.filter((item) => item.requestId === request.requestId).length === 1) throw "unavailable";
        if (["workspacePartial", "workspaceUnknown"].includes(scenario) && !request.force) throw "executionWorkspace";
        if (["sqlUnknown", "workspacePartial", "workspaceUnknown"].includes(scenario)
          && attempts.filter(item=>item.requestId===request.requestId&&item.force===request.force).length===1) {
          throw {code:"storage",reason:{code:scenario==="sqlUnknown"?"DATA_SQL_COMMIT_UNKNOWN":scenario==="workspacePartial"?"DATA_OPERATION_PARTIAL":"DATA_OPERATION_OUTCOME_UNKNOWN",
            reason:{operationId:request.requestId,epoch:renames.epochId(),sqlFence:"7",phase:scenario==="sqlUnknown"?"commit":scenario==="workspaceUnknown"?"delete-workspace-discard":"delete-publication",
              safeCause:scenario==="sqlUnknown"?"sql_commit_outcome_unknown":scenario==="workspacePartial"?"delete_not_archived_after_workspace_cleanup":"workspace_discard_unconfirmed"}}};
        }
        receipts.apply(request, () => {
          conversations = conversations.filter((item) => item.id !== request.conversationId);
        });
        if (scenario === "committedAckLost") throw "unavailable";
      }
      return { schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId };
    },
  };
  const exports: AgentConversationExportGateway = {
    async snapshot(id) {
      const { durableCount, ...conversation } = read(id);
      return { format: "research-assistant.conversation", schemaVersion: 1, conversation, watermark: durableCount, turns: [] };
    },
    async download(id) {
      // Simulate the response without creating a file, just like the deletion adapter.
      return { schemaVersion: 1, conversationId: id, watermark: read(id).durableCount,
        destinationPath: `/mock/Downloads/conversation-${id}.json`, byteSize: 256 };
    },
  };
  const deletionConfirmationPreferences: ConversationDeleteConfirmationPreferences = {
    shouldSkip: () => skipConfirmation,
    setSkipToday: (skip) => { skipConfirmation = skip; },
  };
  const forceDeletionConfirmationPreferences: ConversationDeleteConfirmationPreferences = {
    shouldSkip: () => skipForceConfirmation,
    setSkipToday: (skip) => { skipForceConfirmation = skip; },
  };
  return { firstConversation, catalog, archives, metadata, search, deletions, exports, deletionConfirmationPreferences, forceDeletionConfirmationPreferences, attempts, recoveryStorage };
}
