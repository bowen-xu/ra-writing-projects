import type { AiCandidate, AiRun, PaperAnalysisWorkflow } from "@research-assistant/core/ai";
import type { StructuredResource, StructuredWriteResult } from "@research-assistant/core/structured-resources";
import type { AiAssistanceGateway } from "@research-assistant/workbench-preview/ai-assistance-gateway";
import type { StructuredResourceGateway } from "@research-assistant/workbench-preview/structured-resource-gateway";
import type { MockInternalToolStep } from "./mockInternalToolStep";

export interface MockStructuredGenerationTask {
  readonly paperId: string;
  readonly kind: "portrait" | "structuredReading";
  readonly candidate: AiCandidate;
  readonly target: StructuredResource;
  readonly run?: AiRun;
  readonly workflow?: PaperAnalysisWorkflow;
}
export function mockStructuredCandidateContent(task: MockStructuredGenerationTask) {
  const content = task.candidate.revisions.find(value => value.revision === task.candidate.currentRevision)?.payload;
  if (content?.kind !== "paper_portrait_v1" && content?.kind !== "paper_overview_unit_v1") throw new Error("生成未产生可应用的资源");
  return content;
}
export function mockStructuredCandidateText(resource: StructuredResource): string {
  return resource.draft?.content ?? (resource.content === null ? "" : JSON.stringify(resource.content, null, 2));
}

/** The patch shown in history is built from the exact candidate that was read. */
export function mockStructuredUpdatePatch(path: string, before: string, after: string): string {
  const removed = before ? before.split("\n").map(line => `-${line}\n`).join("") : "";
  const added = after.split("\n").map(line => `+${line}\n`).join("");
  return `*** Begin Patch\n*** Update File: ${path}\n@@\n${removed}${added}*** End Patch`;
}

export function mockStructuredReadFile(current: StructuredResource, record: (step: MockInternalToolStep) => void): string {
  const before = mockStructuredCandidateText(current), chars = Array.from(before);
  for (let startChar = 0; startChar === 0 || startChar < chars.length; startChar += 4000) {
    const end = Math.min(startChar + 4000, chars.length);
    record({name: "research_read_file", arguments: {path: current.sourceUri, view: "candidate", startChar, maxChars: 4000},
      output: {path: current.sourceUri, name: current.title, text: chars.slice(startChar, end).join(""),
        version: `structured:${current.revision}:${current.draft?.id ?? ""}:${current.draft?.revision ?? 0}`,
        startChar, nextChar: end < chars.length ? end : null, view: "candidate"}});
  }
  return before;
}

function templateFields(value: unknown): unknown {
  return Array.isArray(value) ? value.map((field: unknown) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return null;
    const row = field as Record<string, unknown>;
    return {id: row.id, title: row.title, question: row.question, color: row.color ?? null};
  }) : null;
}

/** Mock tool execution, backed by the same resource writes as the preview UI. */
export async function persistMockStructuredTask(
  resources: StructuredResourceGateway, task: MockStructuredGenerationTask,
  record: (step: MockInternalToolStep) => void = () => undefined, conversationId?: string, writable?: ReadonlySet<string>,
): Promise<void> {
  async function update(id: string, content: unknown, expected: StructuredWriteResult["status"], alreadyRead?: StructuredResource): Promise<void> {
    if (writable && !writable.has(id)) throw new Error("资源未授予读写权限");
    const current = alreadyRead ?? await resources.get(id);
    const before = alreadyRead ? mockStructuredCandidateText(current) : mockStructuredReadFile(current, record);
    const raw = JSON.stringify(content, null, 2);
    const patch = mockStructuredUpdatePatch(current.sourceUri, before, raw);
    let result: StructuredWriteResult;
    try { result = await resources.write({resourceId: id, expectedRevision: current.revision,
      ...(current.draft ? {expectedDraftRevision: current.draft.revision} : {}),
      ...(conversationId ? {conversationId} : {}), sourceSnapshotId: task.candidate.evidenceBundle.id,
      requestId: crypto.randomUUID(), content: raw, editorKind: "agent"}); }
    catch (error) {
      record({name: "research_apply_patch", arguments: {patch}, isError: true,
        output: {status: "partial", targets: [{path: current.sourceUri, name: current.title, status: "failed",
          message: error instanceof Error ? error.message : String(error)}]}});
      throw error;
    }
    const status = result.status === "applied" ? "applied" : "failed";
    record({name: "research_apply_patch", arguments: {patch}, output: {
      status: status === "failed" ? "partial" : "complete", targets: [{path: current.sourceUri, name: current.title,
        status, proposalId: result.draft?.id ?? null, structuredResource: {
          status: result.status, resourceId: id, sourceUrl: current.sourceUri, revision: result.resource.revision,
          draftId: result.draft?.id ?? null, draftRevision: result.draft?.revision ?? null,
          errors: result.errors, ...(result.receipt ? {receipt: result.receipt} : {}),
          guidance: result.status === "applied" ? "Saved with pending review. Keep/Undo remains available."
            : "Draft retained. Read candidate view and patch the same source address to repair the listed errors.",
        }}],
    }, ...(status === "failed" ? {isError: true} : {})});
    if (result.status !== expected) throw new Error(result.errors.map(value => value.message).join("；") || "生成资源未成功写入");
  }
  const content = mockStructuredCandidateContent(task);
  await update(task.target.id, content, "applied");
  if (task.kind === "portrait" && content.kind === "paper_portrait_v1") {
    const template = (await resources.list(task.paperId)).find(value => value.kind === "readingTemplate");
    if (template && (!writable || writable.has(template.id))) {
      const current = await resources.get(template.id);
      mockStructuredReadFile(current, record);
      const fields = content.template.map(({claimIds: _, ...field}) => field);
      // Native completion also accepts an unchanged template without another proposal.
      let candidate: {fields?: unknown} | null = null;
      try { candidate = JSON.parse(mockStructuredCandidateText(current) || "null") as {fields?: unknown} | null; }
      catch { /* Preserve and update an invalid existing proposal at the same address. */ }
      if (JSON.stringify(templateFields(candidate?.fields)) !== JSON.stringify(templateFields(fields))) {
        await update(template.id, {kind: "reading_template_v1", schemaVersion: 1, name: "本文阅读模板", fields}, "applied", current);
      }
    }
  }
}

/** Mock generation keeps template adoption and writes at the normal resource boundary. */
export function mockStructuredGeneration(ai: AiAssistanceGateway, resources: StructuredResourceGateway,
  execute: (task: MockStructuredGenerationTask) => Promise<void> = task => persistMockStructuredTask(resources, task),
): AiAssistanceGateway {
  async function apply(runId: string, paperId: string, kind: MockStructuredGenerationTask["kind"],
    owner: {run?: AiRun; workflow?: PaperAnalysisWorkflow}): Promise<void> {
    const candidate = (await ai.listCandidates()).find(value => value.runId === runId);
    const content = candidate?.revisions.find(value => value.revision === candidate.currentRevision)?.payload;
    let target = (await resources.list(paperId)).find(value => value.kind === kind);
    if (!candidate || !content || !target) throw new Error("生成未产生可应用的资源");
    if (kind === "structuredReading" && content.kind === "paper_overview_unit_v1" &&
      content.paperTemplate && "templateResourceId" in content.paperTemplate) {
      const reference = content.paperTemplate;
      if (target.templateRef && (target.templateRef.resourceId !== reference.templateResourceId || target.templateRef.revision !== reference.templateResourceRevision)) {
        throw new Error("采用的模板在生成过程中已变化，请重新生成。");
      }
      if (!target.templateRef) target = await resources.bindTemplate({paperId, templateId: reference.templateResourceId,
        templateRevision: reference.templateResourceRevision, expectedRevision: target.revision, confirmed: false, requestId: crypto.randomUUID()});
    }
    await execute({paperId, kind, candidate, target, ...owner});
  }
  return {...ai,
    startRun: async draft => {
      const paperId = draft.scopeItems[0]?.parentObjectId;
      if (paperId) await resources.importLegacy({requestId: crypto.randomUUID(), paperId});
      const run = await ai.startRun(draft);
      if (paperId && run.status === "needs_review") await apply(run.id, paperId, "portrait", {run});
      return run;
    },
    startPaperAnalysis: async draft => {
      await resources.importLegacy({requestId: crypto.randomUUID(), paperId: draft.paperId});
      const workflow = await ai.startPaperAnalysis(draft);
      const candidateId = workflow.turns.find(value => value.kind === "paper_overview")?.candidateId;
      const candidate = (await ai.listCandidates()).find(value => value.id === candidateId);
      if (candidate) await apply(candidate.runId, draft.paperId, "structuredReading", {workflow});
      return workflow;
    },
  };
}
