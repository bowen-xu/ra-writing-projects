import type { AgentContextPart, AgentContextSelection, AgentContextState } from "@research-assistant/core/agent";
import type { AiEvidenceItem } from "@research-assistant/core/ai";
import type { LiteratureItem } from "@research-assistant/core/literature";
import { READING_TEMPLATE_CATALOG_ID, type StructuredResource } from "@research-assistant/core/structured-resources";

/** Same scoped authority as native generation: frozen sources, writable target, pinned template. */
export function mockStructuredConversationContext(
  paper: LiteratureItem,
  target: StructuredResource,
  evidence: readonly AiEvidenceItem[],
  template?: StructuredResource,
  siblings: readonly StructuredResource[] = [],
): AgentContextState {
  const parts: AgentContextPart[] = [
    ...paper.attachments.filter(file => evidence.some(source => source.attachmentId === file.id))
      .map(file => ({
        resource: {kind: "paper" as const, resourceId: paper.id, attachmentId: file.id},
        label: file.displayName, selected: true, access: "readOnly" as const,
      })),
    {resource: {kind: "structuredObject", resourceId: target.id, access: "readWrite"},
      label: target.title, selected: true, access: "readWrite"},
  ];
  for (const sibling of siblings) {
    if (sibling.id !== target.id && sibling.kind !== "readingTemplate") parts.push({
      resource: {kind: "structuredObject", resourceId: sibling.id, access: "readWrite"},
      label: sibling.title, selected: true, access: "readWrite",
    });
  }
  const standalone: AgentContextSelection[] = [];
  if (template) {
    const access = template.paperId === paper.id ? "readWrite" as const : "readOnly" as const;
    const resource = {kind: "structuredObject" as const, resourceId: template.id, access};
    if (template.paperId === paper.id) {
      parts.push({resource, label: template.title, selected: true, access});
    } else {
      standalone.push({resource, label: template.title});
    }
  }
  standalone.push({label: "全局阅读模板", resource: {
    kind: "templateCatalog", resourceId: READING_TEMPLATE_CATALOG_ID, access: "readOnly",
  }});
  return {schemaVersion: 1, persistent: [
    {label: paper.title, resource: {kind: "paperGroup", resourceId: paper.id, groupAccess: "readWrite", parts}},
    ...standalone,
  ], temporary: []};
}
