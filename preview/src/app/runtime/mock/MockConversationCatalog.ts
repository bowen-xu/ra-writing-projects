import { decodeAgentCatalogPage, decodeAgentSearchPage, type AgentCatalogRequest, type AgentDeletionRequest, type AgentDeletionWriteOptions } from "@research-assistant/core/agent";
import type { AppGateways } from "@research-assistant/workbench-preview/app-gateway-types";
import type { MockIndependentAgents } from "./MockIndependentAgents";
import type { MockWritingAgents } from "./MockWritingAgents";
import { mockConversationDeletionBatch } from "@research-assistant/workbench-preview/mock-conversation-deletion-batch";
/** Global catalog composes storage adapters; the production list owns all UI. */
export function createMockConversationCatalog(independent:MockIndependentAgents, writing:MockWritingAgents, ports:Partial<AppGateways>):Partial<AppGateways> {
  const catalog=ports.agentCatalogGateway!,metadata=ports.agentMetadataGateway!,archives=ports.agentArchiveGateway!,deletions=ports.agentDeletionGateway!,search=ports.agentSearchGateway!,sessions=ports.agentSessionGateway!;
  const remove = (request: AgentDeletionRequest, options?: AgentDeletionWriteOptions) => independent.has(request.conversationId) || independent.deletedRequest(request.requestId)
    ? independent.deletions.delete(request, options) : deletions.delete(request, options);
  async function list(request:AgentCatalogRequest) {
    if(request.binding)return catalog.list(request);
    const rows=[...(await independent.catalog.list({...request,limit:500,before:null})).conversations,...await writing.listConversations(request.archived)];
    const all=rows.filter(row=>Boolean(row.internal)===Boolean(request.internal)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).filter(row=>!request.before||row.createdAt<request.before.createdAt||(row.createdAt===request.before.createdAt&&row.id<request.before.id));
    const conversations=all.slice(0,request.limit),last=conversations.at(-1);
    return decodeAgentCatalogPage({schemaVersion:1,conversations,next:all.length>conversations.length&&last?{id:last.id,createdAt:last.createdAt}:null});
  }
  return {
    agentCatalogGateway:{...catalog,list,activity:async request => request.binding ? await catalog.activity?.(request) ?? []
      : [...await independent.catalog.activity!({}), ...await writing.conversationActivity()],
      rename:request=>independent.has(request.id)||independent.hasRenameOperation(request.operationId)?independent.catalog.rename(request):catalog.rename(request),
      renameStatus:request=>independent.has(request.id)||independent.hasRenameOperation(request.operationId)?independent.catalog.renameStatus(request):catalog.renameStatus(request)},
    agentMetadataGateway:{read:request=>independent.has(request.id)?independent.metadata.read(request):metadata.read(request)},
    agentArchiveGateway:{setArchived:request=>independent.has(request.id)||independent.hasArchiveOperation(request.operationId)?independent.archives.setArchived(request):archives.setArchived(request),
      archiveStatus:request=>independent.has(request.id)||independent.hasArchiveOperation(request.operationId)?independent.archives.archiveStatus(request):archives.archiveStatus(request)},
    agentDeletionGateway:{delete:remove,
      status:request=>independent.has(request.conversationId)||independent.deletedRequest(request.requestId)?independent.deletions.status(request):deletions.status(request)},
    agentDeletionBatchGateway:{deleteBatch:async input=>{
      await writing.beforeDeletionBatch();
      return mockConversationDeletionBatch(input, request => independent.has(request.conversationId) || independent.deletedRequest(request.requestId)
        ? independent.prepareBatchDeletion(request) : writing.prepareBatchDeletion(request));
    }},
    agentSearchGateway:{search:async request=>{if(request.scope.binding)return search.search(request);const [local,bound]=await Promise.all([independent.search.search(request),request.scope.internal ? Promise.resolve([]) : writing.searchConversations(request)]);const all=[...local.hits,...bound].sort((a,b)=>b.conversation.createdAt.localeCompare(a.conversation.createdAt)||b.conversation.id.localeCompare(a.conversation.id));const hits=all.slice(0,request.scope.limit),last=hits.at(-1)?.conversation;return decodeAgentSearchPage({schemaVersion:1,hits,next:all.length>hits.length&&last?{id:last.id,createdAt:last.createdAt}:null});}},
    agentSessionGateway:{create:id=>independent.has(id)?independent.gateway.sessions.create(id):sessions.create(id),open:id=>independent.has(id)?independent.gateway.sessions.open(id):sessions.open(id),readHistory:request=>independent.has(request.conversationId)?independent.gateway.sessions.readHistory(request):sessions.readHistory(request),waitForHistory:(request,signal)=>independent.has(request.conversationId)?independent.gateway.sessions.waitForHistory(request,signal):sessions.waitForHistory(request,signal)},
    agentConversationExportGateway:{snapshot:id=>independent.has(id)?independent.exports.snapshot(id):ports.agentConversationExportGateway!.snapshot(id),download:id=>independent.has(id)?independent.exports.download(id):ports.agentConversationExportGateway!.download(id)},
  };
}
