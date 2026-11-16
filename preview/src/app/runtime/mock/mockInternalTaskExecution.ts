import { freezeAgentContext, type AgentContextPreview, type AgentContextState } from "@research-assistant/core/agent";
import type { StructuredResourceGateway } from "@research-assistant/workbench-preview/structured-resource-gateway";
import { getLiteratureGateway } from "@research-assistant/literature-library-preview";
import { mockContextGrants } from "./mockContextGrants";
import { mockStructuredConversationContext } from "./mockStructuredContext";
import { mockInternalTaskInput } from "./mockInternalTaskInput";
import { readMockBundledTaskSkill } from "./mockBundledTaskSkills";
import type { MockInternalToolStep, MockInternalTurnResult } from "./mockInternalToolStep";
import { mockStructuredCandidateContent, mockStructuredReadFile, persistMockStructuredTask, type MockStructuredGenerationTask } from "./mockStructuredGeneration";

export interface MockInternalTaskExecution {
  readonly preview: AgentContextPreview;
  readonly state: AgentContextState;
  readonly result: MockInternalTurnResult;
  readonly response: string;
  readonly error?: unknown;
}

/** Only provider/source/tool I/O is synthetic. Prompt bindings, receipts and the
 * rendered history use the same contracts as application-owned Agent turns. */
export async function executeMockInternalTask(
  resources: StructuredResourceGateway, task: MockStructuredGenerationTask,
  storage: Storage, conversationId: string, requestId: string, configured?: AgentContextState,
): Promise<MockInternalTaskExecution> {
  const paper = await getLiteratureGateway().get(task.paperId);
  const content = mockStructuredCandidateContent(task);
  const template = task.kind === "portrait" ? (await resources.list(task.paperId)).find(value => value.kind === "readingTemplate")
    : task.target.templateRef ? await resources.getVersion(task.target.templateRef.resourceId, task.target.templateRef.revision) : undefined;
  const siblings = await resources.list(task.paperId);
  const state = configured ?? mockStructuredConversationContext(paper, task.target, task.candidate.evidenceBundle.items, template, siblings);
  const context = (await mockContextGrants(freezeAgentContext(state).map(value => value.resource), true)).map(source => {
    const object = [...siblings, task.target, template].find(value => value?.id === source.resourceId);
    return {...source, anchor: JSON.stringify({...JSON.parse(source.anchor ?? "{}"),
      sourceSnapshotId: task.candidate.evidenceBundle.id,
      ...(object ? {sourceUrl: object.sourceUri, resourceKind: object.kind} : {}),
      ...(source.resourceId === task.target.id && task.target.templateRef ? {frozenTemplateRef: task.target.templateRef} : {}),
    })};
  });
  const writable = new Set(context.filter(source => JSON.parse(source.anchor ?? "{}").contextAccess === "readWrite").map(source => source.resourceId));
  if (!writable.has(task.target.id)) throw new Error("内部任务目标未授予读写权限，请在上下文管理中选择目标并允许读写");
  const prompt = await mockInternalTaskInput(context, task.target, content, storage, task.run?.userGoal);
  const preview: AgentContextPreview = {schemaVersion: 1, conversationId, requestId,
    turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(), input: {
      ...prompt, context, model: {providerId: task.candidate.providerId, modelId: task.candidate.modelId, revision: null}, reasoningEffort: null,
    }};
  const steps: MockInternalToolStep[] = [];
  try {
    const skill = prompt.userInput.find(value => value.type === "skill");
    if (skill?.type === "skill") steps.push({name: "research_load_skill", arguments: {identity: skill.identity},
      output: {skill: {identity: skill.identity, name: skill.name, body: await readMockBundledTaskSkill(skill.identity,storage)}}});
    for (const source of context) {
      const anchor = JSON.parse(source.anchor ?? "{}") as {resource?: {kind: string; attachmentId?: string}; contextAccess?: string};
      if (anchor.resource?.kind === "paper" && anchor.resource.attachmentId) {
        const fileId = anchor.resource.attachmentId;
        const text = JSON.stringify({kind: "frozen_structured_evidence_v1", snapshotId: task.candidate.evidenceBundle.id,
          items: task.candidate.evidenceBundle.items.filter(item => item.attachmentId === fileId).map(item => ({
            evidenceItemId: item.citationKey, attachmentId: item.attachmentId, attachmentSha256: item.contentSha256,
            pageIndex: item.pageIndex, parseRunId: `mock-parse:${item.attachmentId}`, rawRef: `#/texts/${item.ordinal}`, regions: [], kind: "text", quoteExact: item.quoteExact,
          }))});
        const chars = Array.from(text);
        for (let startChar = 0; startChar < chars.length; startChar += 8000) {
          const end = Math.min(startChar + 8000, chars.length);
          steps.push({name: "research_read_source", arguments: {fileId, view: "structured", startChar, maxChars: 8000}, output: {
            sourceId: source.sourceId, resourceId: source.resourceId, revision: task.candidate.evidenceBundle.id,
            text: chars.slice(startChar, end).join(""), startChar, endChar: end, totalChars: chars.length, nextChar: end < chars.length ? end : null,
          }});
        }
      } else if (anchor.resource?.kind === "templateCatalog") {
        const templates = (await resources.list()).filter(value => value.kind === "readingTemplate" && !value.paperId && value.revision > 0);
        steps.push({name: "research_find_sources", arguments: {resourceType: "readingTemplate"}, output: {
          sources: templates.map(value => ({resourceId: value.id, name: value.title, sourceUrl: value.sourceUri, access: "readOnly", revision: value.revision})),
          nextOffset: null,
        }});
      } else if (template?.id === source.resourceId && anchor.contextAccess === "readOnly") {
        const {draft: _, ...formal} = template;
        mockStructuredReadFile(formal, step => steps.push(step));
      }
    }
    await persistMockStructuredTask(resources, task, step => steps.push(step), conversationId, writable);
    return {preview, state, result: {steps}, response: task.kind === "portrait"
      ? "文献画像已保存。本文阅读模板修改保留待审 Diff，可通过 Keep／Undo 审阅。"
      : "结构化阅读记录已保存，可在右侧审阅修改。"};
  } catch (error) {
    return {preview, state, result: {steps, outcome: "failed"},
      response: `生成未完成：${error instanceof Error ? error.message : String(error)}。已有内容和修复草稿保留。`, error};
  }
}
