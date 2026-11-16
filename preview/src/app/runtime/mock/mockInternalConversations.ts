import type { StructuredResourceGateway } from "@research-assistant/workbench-preview/structured-resource-gateway";
import type { AgentContextState } from "@research-assistant/core/agent";
import type { AiAssistanceGateway } from "@research-assistant/workbench-preview/ai-assistance-gateway";
import type { AiRun, PaperAnalysisWorkflow } from "@research-assistant/core/ai";
import { getLiteratureGateway } from "@research-assistant/literature-library-preview";
import type { MockIndependentAgents } from "./MockIndependentAgents";
import { mockStructuredConversationContext } from "./mockStructuredContext";
import { mockContextGrants } from "./mockContextGrants";
import { mockInternalTaskInput } from "./mockInternalTaskInput";
import { mockStructuredGeneration, type MockStructuredGenerationTask } from "./mockStructuredGeneration";
import { executeMockInternalTask } from "./mockInternalTaskExecution";

/** Mock only workflow/journal I/O; the normal catalog and chat render this history. */
export function mockInternalConversations(ai: AiAssistanceGateway, agents: MockIndependentAgents, storage: Storage, resources?: StructuredResourceGateway, saveContext?: (id:string,state:AgentContextState)=>void, readContext?: (id:string)=>AgentContextState|undefined): AiAssistanceGateway {
  const pending = new Map<string, Promise<PaperAnalysisWorkflow>>();
  const portraitRuns = new Map<string, {paperId: string; run: AiRun}>(JSON.parse(storage.getItem("internal-portrait-runs") ?? "[]"));
  const savePortraits = () => storage.setItem("internal-portrait-runs", JSON.stringify([...portraitRuns]));
  async function generationConversation(paperId: string): Promise<string> {
    const key = `internal-paper-generation:${paperId}`;
    const previous = storage.getItem(key) ?? [...portraitRuns.values()].filter(value => value.paperId === paperId).at(-1)?.run.sharedConversationId;
    const current = previous && agents.has(previous) && !(await agents.metadata.read({id: previous})).archived ? previous : crypto.randomUUID();
    storage.setItem(key, current);
    return current;
  }
  async function portraitRun(id: string): Promise<AiRun> {
    const saved = portraitRuns.get(id);
    if (!saved) return ai.getRun(id);
    let run = saved.run;
    try { run = { ...await ai.getRun(id),
      ...(saved.run.status === "failed" ? {status: "failed" as const} : {}),
      ...(saved.run.sharedConversationId ? {sharedConversationId: saved.run.sharedConversationId} : {}),
      ...(saved.run.sharedRequestId ? {sharedRequestId: saved.run.sharedRequestId} : {}) }; } catch { /* Completed mock journals survive reload; the in-memory runner does not. */ }
    return run;
  }
  async function executeTask(task: MockStructuredGenerationTask, conversationId: string, requestId: string): Promise<void> {
    if (!resources) throw new Error("预览缺少结构化资源网关");
    if (agents.has(conversationId)) await agents.assertInternalAvailable(conversationId);
    const execution = await executeMockInternalTask(resources, task, storage, conversationId, requestId, readContext?.(conversationId));
    const title = `文献阅读 · ${task.candidate.evidenceBundle.items[0]?.paperTitle ?? task.paperId}`.slice(0, 180);
    if (agents.has(conversationId)) await agents.appendInternalTurn(execution.preview, execution.response, execution.result);
    else await agents.seedConversation(execution.preview, title, execution.response, true, execution.result);
    saveContext?.(conversationId, execution.state);
    if (task.run) {
      const linked = {...task.run, ...(execution.error ? {status: "failed" as const} : {}), sharedConversationId: conversationId, sharedRequestId: requestId};
      portraitRuns.set(linked.id, {paperId: task.paperId, run: linked}); savePortraits();
    }
    if (execution.error) throw execution.error;
  }
  async function seedJournal(workflow: PaperAnalysisWorkflow): Promise<PaperAnalysisWorkflow> {
    const key = `internal-workflow-conversation:${workflow.id}`;
    const conversationId = storage.getItem(key) ?? crypto.randomUUID();
    if (!agents.has(conversationId)) {
      const candidate = (await ai.listCandidates()).find(value => value.id === workflow.turns[0]?.candidateId);
      if (!candidate) return workflow;
      const paper = await getLiteratureGateway().get(workflow.paperId);
      const target = resources ? (await resources.list(workflow.paperId)).find(value => value.kind === "structuredReading") : undefined;
      const payload = candidate.revisions.at(-1)?.payload;
      if (!resources || !target || payload?.kind !== "paper_overview_unit_v1") return workflow;
      const reference = target.templateRef;
      const template = reference ? await resources.getVersion(reference.resourceId, reference.revision) : undefined;
      const state = mockStructuredConversationContext(paper, target, candidate.evidenceBundle.items, template);
      const context = (await mockContextGrants(state.persistent.map(value => value.resource))).map(source => {
        const object = [target, template].find(value => value?.id === source.resourceId);
        return object ? {...source, anchor: JSON.stringify({...JSON.parse(source.anchor ?? "{}"), sourceUrl: object.sourceUri, resourceKind: object.kind})} : source;
      });
      const prompt = await mockInternalTaskInput(context, target, payload, storage);
      await agents.seedConversation({ schemaVersion: 1, conversationId, requestId: crypto.randomUUID(),
        turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(), input: {
          ...prompt,
          model: {providerId: workflow.providerId, modelId: workflow.modelId, revision: null}, reasoningEffort: null,
          context,
        } }, `文献阅读 · ${paper.title}`.slice(0, 180), "结构化阅读记录已保存；可在右侧审阅修改。", true);
      saveContext?.(conversationId, state);
      storage.setItem(key, conversationId);
    }
    return {...workflow, conversationId};
  }
  function journal(workflow: PaperAnalysisWorkflow): Promise<PaperAnalysisWorkflow> {
    const existing = pending.get(workflow.id);
    if (existing) return existing;
    const operation = seedJournal(workflow).finally(() => pending.delete(workflow.id));
    pending.set(workflow.id, operation);
    return operation;
  }
  return {...ai,
    getRun: portraitRun,
    getLatestPaperPortraitRun: async paperId => {
      const latest = [...portraitRuns.values()].filter(value => value.paperId === paperId).at(-1);
      return latest ? portraitRun(latest.run.id) : undefined;
    },
    startRun: async draft => {
      const paperId = draft.scopeItems[0]?.parentObjectId;
      if (draft.taskKind !== "paper_profile_classification" || !paperId) return ai.startRun(draft);
      const conversationId = await generationConversation(paperId), requestId = crypto.randomUUID();
      const existing = agents.has(conversationId);
      if (resources) {
        const generation = mockStructuredGeneration(ai, resources, task => executeTask(task, conversationId, requestId));
        const run = await generation.startRun(draft);
        const completed = portraitRuns.get(run.id)?.run;
        if (completed) return completed;
        // No provider result means no tool execution; retain cancellation/failure history.
        const preview = {schemaVersion: 1 as const, conversationId, requestId, turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(),
          input: {text: "生成本文文献画像与本文阅读模板。", userInput: [],
            model: {providerId: run.providerId, modelId: run.modelId, revision: null}, reasoningEffort: null, context: []}};
        const report = {steps: [], outcome: run.status === "canceled" ? "canceled" as const : "failed" as const};
        if (existing) await agents.appendInternalTurn(preview, "任务未完成，未执行资源写入。", report);
        else await agents.seedConversation(preview, "文献阅读", "任务未完成，未执行资源写入。", true, report);
        const linked = {...run, sharedConversationId: conversationId, sharedRequestId: requestId};
        portraitRuns.set(run.id, {paperId, run: linked}); savePortraits();
        return linked;
      }
      const run = await ai.startRun(draft);
      const paper = await getLiteratureGateway().get(paperId);
      const preview = {schemaVersion: 1 as const, conversationId, requestId, turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(),
        input: {text: `生成本文文献画像与本文阅读模板。\n${draft.userGoal}`, userInput: [],
          model: {providerId: run.providerId, modelId: run.modelId, revision: null}, reasoningEffort: null, context: []}};
      const response = run.status === "canceled" ? "任务已取消，未执行资源写入。" : "文献画像已生成；历史记录保留。";
      if (existing) await agents.appendInternalTurn(preview, response);
      else await agents.seedConversation(preview, `文献阅读 · ${paper.title}`.slice(0,180), response, true);
      const linked = {...run, sharedConversationId: conversationId, sharedRequestId: requestId};
      portraitRuns.set(run.id, {paperId, run: linked}); savePortraits();
      return linked;
    },
    startPaperAnalysis: async draft => {
      const conversationId = await generationConversation(draft.paperId);
      if (!resources) {
        const workflow = await ai.startPaperAnalysis(draft);
        storage.setItem(`internal-workflow-conversation:${workflow.id}`, conversationId);
        return journal(workflow);
      }
      const generation = mockStructuredGeneration(ai, resources, async task => {
        if (!task.workflow) throw new Error("结构化阅读缺少工作流身份");
        const key = `internal-workflow-conversation:${task.workflow.id}`;
        storage.setItem(key, conversationId);
        await executeTask(task, conversationId, crypto.randomUUID());
      });
      return {...await generation.startPaperAnalysis(draft), conversationId};
    },
    getLatestPaperAnalysisWorkflow: async paperId => {
      const workflow = await ai.getLatestPaperAnalysisWorkflow(paperId);
      return workflow ? journal(workflow) : workflow;
    },
  };
}
