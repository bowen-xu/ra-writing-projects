import {agentContextGroupParts, agentContextKey, compactAgentContextResource, decodeAgentContextResource, isAgentContextGroup, type AgentContextResource, type AgentContextText} from "@research-assistant/core/agent";
import {mockContextCatalog} from "./mockContextCatalog";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";

/** Mock inventory/permission I/O; preparation never reads document or note bodies. */
export async function mockContextGrants(resources: readonly AgentContextResource[], expandGroups = false): Promise<AgentContextText[]> {
  const catalog = await mockContextCatalog("");
  const output: AgentContextText[] = [];
  async function add(input: AgentContextResource): Promise<void> {
    const resource = compactAgentContextResource(decodeAgentContextResource(input));
    if (isAgentContextGroup(resource)) {
      const current = catalog.find(item => agentContextKey(item.resource) === agentContextKey(resource));
      if (!current || !isAgentContextGroup(current.resource)) throw new Error("sourceUnavailable");
      if (resource.newMemberAccess && !expandGroups) {
        const hash = await writingDiffDemoHash(JSON.stringify(resource));
        output.push({sourceId:`resource:${hash}`,kind:resource.kind === "manuscript" ? "manuscript" : "paper",resourceId:resource.resourceId,revision:`grant:${hash}`,anchor:JSON.stringify({content:"resourceGrant",resource,contextAccess:resource.groupAccess === "readOnly" ? "readOnly" : resource.newMemberAccess,...(resource.kind === "manuscript" ? {manuscriptId:resource.resourceId} : {})}),text:JSON.stringify({label:current.label,readWith:"research_list_sources",content:"Current object scope; bodies read on demand."})});
        return;
      }
      const members = new Set(current.resource.parts.map(part => agentContextKey(part.resource)));
      if (resource.parts.some(part => !members.has(agentContextKey(part.resource)))) throw new Error("sourceUnavailable");
      for (const part of agentContextGroupParts(current.resource,resource).filter(part => part.selected)) {
        const start = output.length; await add(part.resource);
        for (let i = start; i < output.length; i++) output[i] = {...output[i]!, anchor:JSON.stringify({...JSON.parse(output[i]!.anchor!),contextAccess:part.access,contextOwner:{kind:resource.kind === "paperGroup" ? "paper" : resource.kind === "noteGroup" ? "note" : "manuscript",resourceId:resource.resourceId}})};
      }
      return;
    }
    const member = catalog.flatMap(item => isAgentContextGroup(item.resource) ? item.resource.parts : []).find(part => agentContextKey(part.resource) === agentContextKey(resource));
    const standalone=catalog.find(item=>agentContextKey(item.resource) === agentContextKey(resource));
    if (!member && !standalone && !(resource.kind === "paper" && !resource.attachmentId && catalog.some(item => item.resource.kind === "paperGroup" && item.resource.resourceId === resource.resourceId))) throw new Error("sourceUnavailable");
    const hash = await writingDiffDemoHash(JSON.stringify(resource));
    const kind = resource.kind === "manuscriptFile" ? "manuscript" : resource.kind === "note" ? "note" : "paper";
    output.push({sourceId:`resource:${hash}`,kind,resourceId:resource.kind === "manuscriptFile" ? resource.path : resource.resourceId,revision:`grant:${hash}`,anchor:JSON.stringify({content:"resourceGrant",resource,contextAccess:(resource.kind === "structuredObject" || resource.kind === "templateCatalog") ? resource.access ?? "readOnly" : "readOnly"}),text:JSON.stringify({label:member?.label ?? standalone?.label ?? "PDF",resource,content:"Available current resource; body not loaded."})});
  }
  for (const resource of resources) await add(resource);
  return [...new Map(output.map(source => [source.sourceId,source])).values()];
}
