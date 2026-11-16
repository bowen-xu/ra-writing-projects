import { AGENT_MODEL_MAX_RECONNECTS, agentContextPathAccess, executionModeForModel, decodeAgentSubmissionPreview, decodeAgentWorkspacePreview, decodeAgentWritingStartResponse, decodeAgentInterruptResponse,
  decodeAgentWritingPrepareRequest, decodeAgentWritingPrepareResult, sameAgentWritingPrepareRequest,
  decodeAgentWritingStartRequest, decodeAgentWritingStartStatusResponse,
  type AgentSubmissionPreview, type AgentWorkspaceBuffer, type AgentWorkspacePreview, type AgentWorkspaceScope,
  type AgentWritingPrepareRequest, type AgentWritingReceipt, type AgentWritingStartRequest, type AgentWritingStartResponse, type AgentWritingSteerRequest, type AgentSteerResponse, type AgentSteeringHandoffIntent, type AgentUserInput, type AgentSkillInstructions, type AgentContextText } from "@research-assistant/core/agent";
import type { AgentSubmissionGateway, AgentWorkspaceGateway, AgentTurnGateway } from "@research-assistant/data/agent";
import type { WritingDiffDemoAgentStorage } from "./WritingDiffDemoAgentStorage";
import type { WritingDiffDemoStorage } from "../../../../agent/WritingDiffDemoStorage";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
import {mockWritingPreparationReceipt, mockWritingPreparationStatus, mockWritingPreparationUnconfirmed, requireMockWritingPreparation,
  type MockWritingPreparationPurpose, type MockWritingPreparationReceipt, type MockWritingPreparationSources} from "@research-assistant/workbench-preview/mock-writing-preparation";

import {MockAgentResourceRuntime} from "@research-assistant/workbench-preview/mock-agent-resource-runtime";
import { WritingDemoFeedback } from "@research-assistant/workbench-preview/writing-demo-feedback";
import { writingDemoPatch } from "@research-assistant/workbench-preview/writing-demo-patch-contract";
import { WritingDemoResponseSequence, type WritingDemoResponseTexts, type WritingDemoPatchFailure } from "@research-assistant/workbench-preview/writing-demo-response-sequence";
import { WritingDemoSingleText } from "@research-assistant/workbench-preview/writing-demo-single-text";
import {mockWritingStartHasHistoricalManuscript, mockWritingStartUnconfirmed, observeMockWritingStart} from "@research-assistant/workbench-preview/mock-writing-start-observation";
import { DEFAULT_DEMO_TEXT_PACING, type WritingDemoTextPacing } from "@research-assistant/workbench-preview/writing-demo-text-stream";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-preview/writing-submission-controller";
interface Prepared {
  readonly purpose?: MockWritingPreparationPurpose;
  readonly preparation?: MockWritingPreparationReceipt;
  readonly acceptPrepared?: (accept: () => void) => void;
  readonly toolsAllowed:boolean;
  readonly steers:Map<string,{text:string;userInput:readonly AgentUserInput[]; skillInstructions:readonly AgentSkillInstructions[]}>;
  readonly injected: Set<string>;
  readonly confirmedSteers:Set<string>;
  readonly request: AgentWritingPrepareRequest;
  readonly preview: AgentSubmissionPreview;
  workspace?: AgentWorkspacePreview;
  buffers?: readonly AgentWorkspaceBuffer[];
  started: boolean;
  outcome: "completed" | "failed" | "canceled" | null;
  singleResponse?: WritingDemoSingleText;
  timer?: ReturnType<typeof setTimeout>;
  finish?:()=>void;
  responses?: WritingDemoResponseSequence;
  feedback?: WritingDemoFeedback;
  intervalMs?: number;
  reconnecting?: boolean;
  retryAttemptId?: string;
  reconnectFailures?: number;
}
const key = (scope: { conversationId: string; requestId: string }) => JSON.stringify([scope.conversationId, scope.requestId]);
/** Native submission/workspace I/O simulation. It freezes model input and an
 * execution copy, then publishes a deterministic completion. Only production
 * delivery/application controllers may install the result into editor files. */
export class WritingDiffDemoSubmission {
  snapshot() {
    return structuredClone([...this.records].map(([identity, value]) => [identity, {
      toolsAllowed: value.toolsAllowed, steers: value.steers, injected: value.injected,
      confirmedSteers: value.confirmedSteers, request: value.request, preview: value.preview,
      ...(value.purpose ? {purpose: value.purpose} : {}), ...(value.preparation ? {preparation: value.preparation} : {}),
      ...(value.workspace ? { workspace: value.workspace } : {}),
      ...(value.buffers ? { buffers: value.buffers } : {}), started: value.started, outcome: value.outcome,
    }] as const));
  }
  restore(snapshot: ReturnType<WritingDiffDemoSubmission["snapshot"]>): void {
    this.generation++; this.preparations.clear();
    for(const timer of this.timers)clearTimeout(timer);
    this.timers.clear();
    this.records.clear();
    for (const [identity, value] of snapshot) {
      const restored=structuredClone(value);
      // Like native startup reconciliation, only inputs already committed to
      // history survive a stopped process; pending deliveries are not replayed.
      for(const id of restored.steers.keys())if(!restored.confirmedSteers.has(id))restored.steers.delete(id);
      this.records.set(identity, {...restored, outcome: value.started && value.outcome === null ? "canceled" : value.outcome});
    }
  }
  private readonly records = new Map<string, Prepared>();
  /** Observes the original admitted input; absence is not itself proof that a
   * delayed acceptance cannot still arrive. */
  steeringHandoffAdmission(intent:AgentSteeringHandoffIntent):"absent"|"matching"|"conflicting"{
    let result:"absent"|"matching"|"conflicting"="absent";
    for(const value of this.records.values()){
      const input=value.steers.get(intent.steeringInputId);
      if(!input)continue;
      if(result!=="absent")return "conflicting";
      result=value.preview.conversationId===intent.conversationId && value.preview.turnId===intent.turnId
        && input.text===intent.text && JSON.stringify(input.userInput)===JSON.stringify(intent.userInput) ? "matching" : "conflicting";
    }
    return result;
  }
  /** Prepare a non-throwing discard for the same synchronous mock transaction
   * that releases a terminal, unconsumed queue handoff. */
  prepareSteeringHandoffDiscard(intent:AgentSteeringHandoffIntent):(()=>void)|undefined{
    const admission=this.steeringHandoffAdmission(intent);
    if(admission==="conflicting")throw {code:"conflict"};
    if(admission==="absent")return undefined;
    const record=[...this.records.values()].find(value=>value.steers.has(intent.steeringInputId));
    if(!record || record.confirmedSteers.has(intent.steeringInputId))throw {code:"conflict"};
    return ()=>{record.steers.delete(intent.steeringInputId);};
  }
  private readonly preparations = new Map<string, { readonly request: string; readonly result: Promise<AgentSubmissionPreview> }>();
  private generation = 0;
  private readonly prepareEpoch = crypto.randomUUID();
  private nextPrepareFailure: "rejected" | "beforeCommit" | "afterCommit" | "unavailable" | null = null;
  private prepareReaderUnavailable = false;
  private startReaderUnavailable = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  delayMs = 600;
  contextSources: ((resources: readonly import("@research-assistant/core/agent").AgentContextResource[], primaryManuscriptId?:string) => Promise<readonly import("@research-assistant/core/agent").AgentContextText[]>) | undefined;
  retrievalPreparation: ((request: AgentWritingPrepareRequest) => Promise<MockWritingPreparationSources>) | undefined;
  private textPacing = DEFAULT_DEMO_TEXT_PACING;
  private readonly readTextPacing = (): WritingDemoTextPacing => this.textPacing;
  singleTextResponse: string | undefined;
  multipleResponses = false;
  progressiveFeedback = false;
  /** Seeded history owns its lifecycle; never append normal simulated file edits. */
  historyOnly = false;
  responseTexts: WritingDemoResponseTexts | undefined;
  patchFailure: WritingDemoPatchFailure | undefined;
  failNextPrepare(failure: typeof this.nextPrepareFailure): void {this.nextPrepareFailure = failure;}
  failPrepareStatus(unavailable: boolean): void {this.prepareReaderUnavailable = unavailable;}
  failStartStatus(unavailable: boolean): void {this.startReaderUnavailable = unavailable;}
  nextSteerFailure:"rejected"|"beforeCommit"|"afterCommit"|null=null;
  private commitSteer(value:Prepared,inputId:string,text:string):void{
    if(value.outcome!==null||!value.steers.has(inputId)||value.confirmedSteers.has(inputId))return;
    this.agent.history.steer({scope:{manuscriptId:this.manuscriptId,conversationId:value.preview.conversationId,requestId:value.preview.requestId,contextSnapshotId:value.preview.contextSnapshotId},turnId:value.preview.turnId},inputId,text);
    value.confirmedSteers.add(inputId);
  }
  /** Advance explicit history-only test fixtures at a simulated response boundary. */
  consumeSteersAtFixtureBoundary(conversationId:string,turnId:string):void{
    const value=[...this.records.values()].find(record=>record.preview.conversationId===conversationId&&record.preview.turnId===turnId);
    if(!value || !this.historyOnly || value.outcome!==null)throw new Error("模拟边界不可用");
    for(const [id,input] of value.steers)this.commitSteer(value,id,input.text);
  }
  simulateReconnect(conversationId:string, exhaust = false):void {
    const value=[...this.records.values()].find(item=>item.preview.conversationId===conversationId&&item.started&&item.outcome===null);
    if(!value || value.reconnecting)return;
    value.reconnecting = true;
    if(value.timer!==undefined){clearTimeout(value.timer);this.timers.delete(value.timer);delete value.timer;}
    const admission={scope:{manuscriptId:this.manuscriptId,conversationId,requestId:value.preview.requestId,contextSnapshotId:value.preview.contextSnapshotId},turnId:value.preview.turnId};
    const model=value.preview.input.model,attemptId=value.retryAttemptId ?? crypto.randomUUID();
    value.reconnectFailures = (value.reconnectFailures ?? 0) + 1;
    this.agent.history.feedbackEvents(admission,[{type:"phaseChanged",turnId:value.preview.turnId,phase:"runningModel"},
      ...(!value.retryAttemptId ? [{type:"modelRequestStarted" as const,turnId:value.preview.turnId,attemptId,model}] : []),
      {type:"modelRequestFailed",turnId:value.preview.turnId,attemptId,error:"模拟网络连接中断",retryable:value.reconnectFailures <= AGENT_MODEL_MAX_RECONNECTS,category:"providerTemporaryUnavailable"}]);
    delete value.retryAttemptId;
    const finishFailed = () => {
      value.reconnecting = false;
      this.agent.history.feedbackEvents(admission, [{type:"turnFailed",turnId:value.preview.turnId,error:"模拟网络连接中断",category:"providerTemporaryUnavailable"}]);
      void this.agent.complete(admission, [], "failed").then(() => { value.outcome = "failed"; });
    };
    const schedule = () => {
      if ((value.reconnectFailures ?? 0) > AGENT_MODEL_MAX_RECONNECTS) { finishFailed(); return; }
      const timer=setTimeout(()=>{
        this.timers.delete(timer);delete value.timer;
        if(value.outcome!==null)return;
        const next=crypto.randomUUID();
        this.agent.history.feedbackEvents(admission,[{type:"modelRequestStarted",turnId:value.preview.turnId,attemptId:next,model}]);
        if (exhaust) {
          value.reconnectFailures = (value.reconnectFailures ?? 0) + 1;
          this.agent.history.feedbackEvents(admission,[{type:"modelRequestFailed",turnId:value.preview.turnId,attemptId:next,error:"模拟网络连接中断",retryable:value.reconnectFailures <= AGENT_MODEL_MAX_RECONNECTS,category:"providerTemporaryUnavailable"}]);
          schedule();
          return;
        }
        value.reconnecting = false;
        (value.singleResponse ?? value.responses ?? value.feedback)?.restartIncompleteResponse();
        value.retryAttemptId = next;
        this.agent.history.feedbackEvents(admission,[{type:"modelResponseStarted",turnId:value.preview.turnId,attemptId:next,responseId:crypto.randomUUID(),model}]);
        if(value.singleResponse)this.scheduleSingleResponse(value);else this.schedule(value);
      },3000);
      value.timer=timer;this.timers.add(timer);
    };
    schedule();
  }
  constructor(private readonly storage: Pick<WritingDiffDemoStorage, "files" | "checkpoints">, private readonly agent: WritingDiffDemoAgentStorage,
    private readonly manuscriptId: string,readonly resources=new MockAgentResourceRuntime()) {}
  inspectSubmission(conversationId: string, turnId: string): unknown {
    this.agent.history.assertAvailable(conversationId);
    const record = [...this.records.values()].find(value => value.preview.conversationId === conversationId && value.preview.turnId === turnId);
    return record ? structuredClone({ requestId: record.preview.requestId,
      contextSnapshotId: record.preview.contextSnapshotId, input: record.preview.input }) : null;
  }
  /** Read an exact frozen record without resolving sources or granting start. */
  inspectFrozen(scope: AgentWritingReceipt): AgentSubmissionPreview | null {
    this.agent.history.assertAvailable(scope.conversationId);
    if (this.disposed || scope.manuscriptId !== this.manuscriptId) throw {code: "confirmationMismatch"};
    return structuredClone(this.records.get(key(scope))?.preview ?? null);
  }
  inspectPreparation(scope: AgentWritingReceipt) {
    this.agent.history.assertAvailable(scope.conversationId);
    if (this.disposed || scope.manuscriptId !== this.manuscriptId) throw {code: "confirmationMismatch"};
    const value = this.records.get(key(scope));
    return value ? structuredClone({preview: value.preview, ...(value.purpose ? {purpose: value.purpose} : {})}) : null;
  }
  /** Queued admission validates its frozen execution copy before publishing I/Q.
   * This is a read; it does not create a turn or prepare a second model. */
  validateQueuedStart(request: AgentWritingStartRequest): void {
    const value = this.record(request), preview = value.preview;
    if (!value.workspace || !value.buffers || request.contextSnapshotId !== preview.contextSnapshotId
      || JSON.stringify(request.model) !== JSON.stringify(preview.input.model)) throw {code: "confirmationMismatch"};
    if (executionModeForModel(preview.input.model, preview.input.reasoningEffort) !== request.mode) throw {code: "unsupportedModel"};
  }
  /** Durable history is authoritative even after execution-copy/plan cleanup. */
  async inspectStarted(request: AgentWritingStartRequest, preview?: AgentSubmissionPreview): Promise<AgentWritingStartResponse | null> {
    return observeMockWritingStart(this.agent.history.gateway, request, preview ?? this.records.get(key(request))?.preview ?? null, "regular");
  }

  inspectUserInput(request: import("@research-assistant/workbench-preview/message-inspection-gateway").MessageInspectionRequest): readonly AgentUserInput[] {
    const events = this.agent.history.inspectMessage(request);
    if (!events.some(event => event.payload.type === "itemStarted" && event.payload.kind.type === "userMessage")) return [];
    const record = [...this.records.values()].find(value => value.preview.conversationId === request.conversationId && value.preview.turnId === request.turnId);
    const input = record?.steers.get(request.itemId)?.userInput
      ?? (this.agent.history.isFirstUserMessage(request) ? record?.preview.input.userInput : undefined);
    return structuredClone(input ?? []);
  }
  private record(scope: { conversationId: string; requestId: string; manuscriptId: string }): Prepared {
    this.agent.history.assertAvailable(scope.conversationId);
    const value = this.records.get(key(scope));
    if (!value || scope.manuscriptId !== this.manuscriptId) throw new Error("模拟冻结提交不存在");
    return value;
  }
  private async prepare(input: AgentWritingPrepareRequest): Promise<AgentSubmissionPreview> {
    const request = decodeAgentWritingPrepareRequest(input);
    this.agent.history.assertAvailable(request.conversationId);
    if (this.disposed || request.context.manuscriptId !== this.manuscriptId) throw {code: "confirmationMismatch"};
    const identity = key(request), serialized = JSON.stringify(request), pending = this.preparations.get(identity);
    if (pending) {
      if (pending.request !== serialized) throw {code: "confirmationMismatch"};
      return structuredClone(await pending.result);
    }
    const result = this.capture(request), entry = { request: serialized, result };
    this.preparations.set(identity, entry);
    try { return structuredClone(await result); }
    finally { if (this.preparations.get(identity) === entry) this.preparations.delete(identity); }
  }
  private async capture(request: AgentWritingPrepareRequest): Promise<AgentSubmissionPreview> {
    if (request.context.manuscriptId !== this.manuscriptId) throw new Error("模拟提交稿件身份不匹配");
    const existing = this.records.get(key(request));
    if (existing) {
      if (!sameAgentWritingPrepareRequest(existing.request, request) || (existing.purpose && existing.purpose !== "regular")) throw {code: "confirmationMismatch"};
      return requireMockWritingPreparation(mockWritingPreparationStatus(request, existing, "regular", null));
    }
    const generation = this.generation, value = await this.materialize(request, "regular");
    this.agent.history.assertAvailable(request.conversationId);
    if (this.disposed || this.generation !== generation) throw {code: "closed"};
    try {decodeAgentWritingPrepareResult(value.preview, request);} catch {throw {code: "invalidInput"};}
    this.publishPrepared(value, frozen => {
      this.agent.history.assertAvailable(request.conversationId);
      if (this.disposed || this.generation !== generation) throw {code: "closed"};
      this.records.set(key(request), {...frozen, purpose: "regular", preparation: mockWritingPreparationReceipt(request, value.preview, "regular", null, this.prepareEpoch)});
    });
    return structuredClone(value.preview);
  }
  /** Compaction publishes its purpose, queue claim and frozen input together.
   * Source reads alone must never leave an ordinary submission behind. */
  async materializeCompaction(input: AgentWritingPrepareRequest, purpose: Exclude<MockWritingPreparationPurpose, "regular"> = "queuedRegular") {
    const request = decodeAgentWritingPrepareRequest(input), identity = key(request), generation = this.generation;
    const requireVacant = (): void => {
      this.agent.history.assertAvailable(request.conversationId);
      if (this.disposed || this.generation !== generation) throw new Error("模拟冻结提交已关闭");
      if (this.records.has(identity) || this.preparations.has(identity)) throw { code: "confirmationMismatch" };
    };
    requireVacant();
    const value = await this.materialize(request, purpose);
    return { preview: structuredClone(value.preview), commit: (accept: () => void): void => {
      requireVacant();
      this.publishPrepared(value, frozen => {requireVacant(); accept(); this.records.set(identity, {...frozen, purpose});});
    } };
  }
  private publishPrepared(value: Prepared, accept: (frozen: Prepared) => void): void {
    const {acceptPrepared, ...frozen} = value;
    if (acceptPrepared) acceptPrepared(() => accept(frozen)); else accept(frozen);
  }
  private async materialize(request: AgentWritingPrepareRequest, purpose: MockWritingPreparationPurpose): Promise<Prepared> {
    if (request.context.manuscriptId !== this.manuscriptId) throw new Error("模拟提交稿件身份不匹配");
    const captured = structuredClone(request);
    const project = captured.resources?.find(resource => resource.kind === "manuscript" && resource.resourceId === this.manuscriptId);
    const typed = purpose === "regular" || purpose === "manualCompact";
    const files = project?.kind === "manuscript" ? captured.context.files.filter(file => agentContextPathAccess(project,file.relativePath)) : captured.context.files;
    const context: AgentContextText[] = await Promise.all(files.map(async file => {
      const disk = await this.storage.files.readFile(this.manuscriptId, file.relativePath);
      if (disk.sha256.toLowerCase() !== file.expectedDiskSha256.toLowerCase()) throw {code: "conflict"};
      return {sourceId: `writing:${await writingDiffDemoHash(`${this.manuscriptId}/${file.relativePath}`)}`,
        kind: "manuscript" as const, resourceId: file.relativePath, revision: file.buffer?.revision ?? file.expectedDiskSha256,
        anchor: JSON.stringify({manuscriptId: this.manuscriptId, diskSha256: file.expectedDiskSha256}), text: file.buffer?.text ?? disk.content};
    }));
    if (captured.resources?.length) {
      const extra = this.contextSources ? (await Promise.all(captured.resources.map(resource => this.contextSources!([resource],this.manuscriptId).catch(cause => {if (typed) throw cause; return [];})))).flat() : (await Promise.all(captured.resources.map(async resource => {
        if (resource.kind === "manuscript" && resource.resourceId === this.manuscriptId) return undefined;
        if (resource.kind !== "manuscriptFile" || resource.resourceId !== this.manuscriptId) throw new Error("模拟材料不可用");
        const saved = await this.storage.files.readFile(this.manuscriptId, resource.path);
        return {sourceId: `writing:${await writingDiffDemoHash(`${this.manuscriptId}/${resource.path}`)}`, kind: "manuscript" as const,
          resourceId: resource.path, revision: saved.sha256, anchor: JSON.stringify({manuscriptId: this.manuscriptId}), text: saved.content};
      }).map(read => read.catch(cause => {if (typed) throw cause; return undefined;})))).filter((source): source is NonNullable<typeof source> => source !== undefined);
      for (const source of extra) {
        const existing=context.find(existing => existing.sourceId === source.sourceId);
        if(existing){if(project)Object.assign(existing,{anchor:source.anchor});}else context.push(source);
      }
    }
    const retrieval = captured.retrieval ? await this.retrievalPreparation?.(structuredClone(captured)) : undefined;
    if (captured.retrieval && !retrieval) throw {code: "invalidInput"};
    if (retrieval) context.push(...structuredClone(retrieval.context));
    const userInput = structuredClone(captured.userInput);
    for (const input of userInput ?? []) if (input.type === "mention" && input.target.kind === "file" && input.target.sourceId.startsWith("context:")) {
      const resource = JSON.parse(input.target.sourceId.slice(8)) as import("@research-assistant/core/agent").AgentContextResource;
      const source = context.find(s => resource.kind === "manuscriptFile" ? s.resourceId === resource.path && s.anchor?.includes(resource.resourceId) : s.resourceId === resource.resourceId);
      if (!source) continue;
      Object.assign(input.target, {sourceId: source.sourceId, resourceId: source.resourceId});
    }
    this.agent.history.assertAvailable(request.conversationId);
    const references=await this.resources.freeze(captured.text,userInput,context);
    const preview = decodeAgentSubmissionPreview({ schemaVersion: 1, conversationId: captured.conversationId,
      requestId: captured.requestId, manuscriptId: this.manuscriptId, turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(),
      input: { ...references, ...(captured.model?.serviceTier ? { serviceTier: captured.model.serviceTier } : {}),text: captured.text, reasoningEffort: captured.model?.reasoningEffort ?? null,
        model: { providerId: captured.model?.providerId ?? "deepseek", modelId: captured.model?.modelId ?? "deepseek-v4-pro", revision: "mock" }, context } });
    return {request: captured, preview, ...(retrieval ? {acceptPrepared: (accept: () => void) => retrieval.commit(accept)} : {}),
      started: false, outcome: null, toolsAllowed:this.resources.approved, steers:new Map(), confirmedSteers:new Set(), injected:new Set(references.skillInstructions.map(prompt=>JSON.stringify(prompt.identity)))};
  }
  private schedule(value: Prepared): void {
    const feedback = value.responses ?? value.feedback;
    const interval = value.intervalMs ?? this.delayMs;
    const delayMs = this.progressiveFeedback && feedback
      ? feedback.remainingSteps ? feedback.nextDelayMs(interval) : 0 : interval;
    const timer = setTimeout(() => {
      this.timers.delete(timer); delete value.timer;
      if (value.outcome === null) value.finish?.();
    }, delayMs);
    value.timer = timer; this.timers.add(timer);
  }
  private scheduleSingleResponse(value: Prepared): void {
    const response = value.singleResponse!;
    const timer = setTimeout(() => {
      this.timers.delete(timer); delete value.timer;
      if (value.outcome === null) value.finish?.();
    }, response.nextDelayMs(this.delayMs));
    value.timer = timer; this.timers.add(timer);
  }
  private startSingleResponse(value: Prepared, admission: WritingSubmissionAdmission, text: string, completion?: () => Promise<void>): void {
    value.singleResponse = new WritingDemoSingleText(text, this.readTextPacing);
    value.finish = () => {
      if (value.outcome !== null) return;
      if (value.singleResponse!.next(this.agent.history, admission)) value.reconnectFailures = 0;
      if (value.singleResponse!.remainingSteps) { this.scheduleSingleResponse(value); return; }
      for(const [id,input] of value.steers)this.commitSteer(value,id,input.text);
      this.finishRetryAttempt(value, admission);
      void (completion ? completion() : this.agent.complete(admission, [], "completed", [], true))
        .then(() => { value.outcome = "completed"; })
        .catch(async () => { await this.agent.complete(admission, [], "failed"); value.outcome = "failed"; });
    };
    this.scheduleSingleResponse(value);
  }
  private async deliverFiles(value: Prepared, admission: WritingSubmissionAdmission,
    changes: readonly import("@research-assistant/workbench-preview/writing-diff-fixtures").DemoChange[], buffers: readonly AgentWorkspaceBuffer[]): Promise<void> {
    await this.agent.complete(admission, changes, "completed", buffers, true, true);
    if (this.disposed || value.outcome !== null) return;
    if (!value.responses && !value.feedback) this.agent.history.responseStep(admission, {
      ...writingDemoPatch(admission.scope.manuscriptId, changes), phase: "commentary",
      text: "修改已在执行副本中准备，正在保存文件。",
    });
    const callId = crypto.randomUUID(), itemId = crypto.randomUUID(), { turnId } = admission;
    this.agent.history.feedbackEvents(admission, [
      { type: "phaseChanged", turnId, phase: "runningTools" },
      { type: "itemStarted", turnId, itemId, kind: { type: "toolCall", callId, name: "research_deliver_files" } },
      { type: "textDelta", turnId, itemId, text: "{}" }, { type: "itemCompleted", turnId, itemId },
    ]);
    const result = await this.agent.tools.request(admission);
    if (this.disposed || value.outcome !== null) return;
    const resultId = crypto.randomUUID();
    this.agent.history.feedbackEvents(admission, [
      { type: "itemStarted", turnId, itemId: resultId, kind: { type: "toolResult", callId, isError: !result.complete } },
      { type: "textDelta", turnId, itemId: resultId, text: JSON.stringify({ status: result.complete ? "complete" : "unconfirmed", message: result.message }) },
      { type: "itemCompleted", turnId, itemId: resultId }, { type: "phaseChanged", turnId, phase: "runningModel" },
    ]);
    this.startSingleResponse(value, admission, result.complete ? "本轮文件修改已保存。" :
      "本轮文件修改未完整完成：保存或签收工具返回错误，部分内容可能已进入编辑器。我不会重新应用补丁；未确认的原操作已保留，仍可继续对话。",
      async () => { this.agent.history.complete(admission, changes, true); });
  }
  private finishRetryAttempt(value: Prepared, admission: WritingSubmissionAdmission): void {
    if (!value.retryAttemptId) return;
    this.agent.history.feedbackEvents(admission, [{type:"modelRequestFinished",turnId:value.preview.turnId,attemptId:value.retryAttemptId,inputTokens:null,outputTokens:null}]);
    delete value.retryAttemptId;
    value.reconnectFailures = 0;
  }
  setTextPacing(pacing: WritingDemoTextPacing): void {
    if (!Number.isInteger(pacing.charactersPerChunk) || pacing.charactersPerChunk < 1
      || !Number.isFinite(pacing.intervalMs) || pacing.intervalMs < 10) throw new Error("模拟文字速度无效");
    this.textPacing = { ...pacing };
    for (const value of this.records.values()) {
      const response = value.singleResponse ?? value.responses ?? value.feedback;
      if (value.timer === undefined || value.reconnecting || !response?.isStreaming || value.outcome !== null) continue;
      clearTimeout(value.timer); this.timers.delete(value.timer); delete value.timer;
      if (value.singleResponse) this.scheduleSingleResponse(value);
      else this.schedule(value);
    }
  }
  reschedule(delayMs:number):void{this.delayMs=delayMs;for(const value of this.records.values()){if(value.timer===undefined||value.reconnecting||!value.finish)continue;clearTimeout(value.timer);this.timers.delete(value.timer);if(value.singleResponse){this.scheduleSingleResponse(value);continue;}value.intervalMs=delayMs/(this.progressiveFeedback ? Math.max(1,value.responses?.remainingWaitSteps??value.feedback?.remainingWaitSteps??1) : (value.responses?.remainingSteps??0)+1);this.schedule(value);}}
  async finishScenario(outcome:"completed"|"failed"|"canceled"):Promise<void>{for(const value of this.records.values()){if(value.timer!==undefined){clearTimeout(value.timer);this.timers.delete(value.timer);delete value.timer;}if(value.outcome!==null)continue;const admission={scope:{manuscriptId:this.manuscriptId,conversationId:value.preview.conversationId,requestId:value.preview.requestId,contextSnapshotId:value.preview.contextSnapshotId},turnId:value.preview.turnId};if(outcome==="failed")this.agent.history.toolFailure(admission);await this.agent.complete(admission,[],outcome,[],this.historyOnly);value.outcome=outcome;}}
  readonly steer=async(request:AgentWritingSteerRequest):Promise<AgentSteerResponse>=>{
    const value=[...this.records.values()].find(item=>item.preview.conversationId===request.conversationId&&item.preview.turnId===request.turnId);
    const actualTurnId=this.agent.history.activeTurn(request.conversationId);
    if(actualTurnId&&actualTurnId!==request.turnId)throw {code:"expectedTurnMismatch",actualTurnId};
    if(!value||!value.started||value.outcome!==null||actualTurnId===null||request.manuscriptId!==this.manuscriptId)throw {code:"closed"};
    const previous=value.steers.get(request.inputId);const input={text:request.text,userInput:request.userInput??[]};
    if(previous&&(previous.text!==input.text||JSON.stringify(previous.userInput)!==JSON.stringify(input.userInput)))throw {code:"conflict"};
    if(!previous){
      const failure=this.nextSteerFailure;this.nextSteerFailure=null;
      if(failure==="rejected")throw {code:"activeTurnNotSteerable"};
      if(failure==="beforeCommit")throw new Error("模拟 Steer 发送失败");
      const frozen=await this.resources.freeze(request.text,request.userInput,value.preview.input.context,value.preview.input.skills,value.toolsAllowed);value.steers.set(request.inputId,{...input,skillInstructions:frozen.skillInstructions});
      if(failure==="afterCommit")throw new Error("模拟 Steer 接收后回执丢失");
    }
    return {schemaVersion:1,conversationId:request.conversationId,turnId:request.turnId,inputId:request.inputId};
  };
  hasExecutionWorkspace(id: string): boolean {
    return [...this.records.values()].some(entry => entry.request.conversationId === id && entry.workspace !== undefined);
  }
  /** Advance the legacy seeded fixture after its configured wait; all events
   * remain mock data and do not represent the native scheduler. */
  continueSeededHistory(admission: WritingSubmissionAdmission, finishTool: () => void): void {
    const value=this.record(admission.scope);
    if (!value.started || value.outcome!==null || value.timer!==undefined) throw new Error("模拟工具场景不可继续");
    value.finish=()=>{
      if(value.outcome!==null)return;
      finishTool();
      for(const [id,input] of value.steers)this.commitSteer(value,id,input.text);
      void this.agent.complete(admission,[],"completed",[],true)
        .then(()=>{value.outcome="completed";})
        .catch(async()=>{await this.agent.complete(admission,[],"failed",[],true);value.outcome="failed";});
    };
    this.schedule(value);
  }
  deleteConversation(id: string): void {
    for (const [identity, entry] of this.records) if (entry.request.conversationId === id) {
      if (entry.timer !== undefined) { clearTimeout(entry.timer); this.timers.delete(entry.timer); }
      this.records.delete(identity);
    }
    for (const identity of this.preparations.keys()) if (JSON.parse(identity)[0] === id) this.preparations.delete(identity);
  }
  readonly submission: AgentSubmissionGateway = {
    prepareWriting: async request => {
      const fault = this.nextPrepareFailure; if (fault !== "unavailable") this.nextPrepareFailure = null;
      if (fault === "rejected") throw {code: "invalidInput"};
      if (fault === "beforeCommit" || fault === "unavailable") throw "AGENT_PREVIEW_SYNTHETIC_IO_BEFORE_COMMIT";
      const result = await this.prepare(request);
      if (fault === "afterCommit") throw "AGENT_PREVIEW_SYNTHETIC_IO_ACK_LOST";
      return result;
    },
    prepareWritingStatus: async input => {
      const request = decodeAgentWritingPrepareRequest(input); this.agent.history.assertAvailable(request.conversationId);
      if (this.disposed || request.context.manuscriptId !== this.manuscriptId) throw {code: "confirmationMismatch"};
      return {schemaVersion: 1, intent: request, status: this.prepareReaderUnavailable
        ? mockWritingPreparationUnconfirmed(request, "mock_writing_prepare_reader_unavailable")
        : mockWritingPreparationStatus(request, this.records.get(key(request)), "regular", null)};
    },
    restoreWriting: async request => {const record = this.record(request); return decodeAgentWritingPrepareResult(record.preview, record.request);},
    startStatus: async input => {
      const intent = decodeAgentWritingStartRequest(input), value = this.records.get(key(intent));
      let status;
      try {
        if (this.startReaderUnavailable) throw new Error("mock_writing_start_reader_unavailable");
        if (intent.manuscriptId !== this.manuscriptId || value && (value.purpose && value.purpose !== "regular"
          || value.preview.manuscriptId !== intent.manuscriptId || value.preview.conversationId !== intent.conversationId || value.preview.requestId !== intent.requestId))
          status = mockWritingStartUnconfirmed(intent.requestId, "writing_start_purpose_mismatch");
        else if (value && (value.preview.contextSnapshotId !== intent.contextSnapshotId || JSON.stringify(value.preview.input.model) !== JSON.stringify(intent.model)))
          status = mockWritingStartUnconfirmed(intent.requestId, "writing_start_intent_mismatch");
        else if (value && !mockWritingStartHasHistoricalManuscript(value.preview, intent.manuscriptId))
          status = mockWritingStartUnconfirmed(intent.requestId, "writing_start_scope_unconfirmed");
        else {
          const result = await observeMockWritingStart(this.agent.history.gateway, intent, value?.preview ?? null, "regular");
          status = result ? {type: "started" as const, result} : value ? {type: "prepared" as const, preview: value.preview} : {type: "notFound" as const};
        }
        return decodeAgentWritingStartStatusResponse({schemaVersion: 1, intent, status});
      } catch {return decodeAgentWritingStartStatusResponse({schemaVersion: 1, intent,
        status: mockWritingStartUnconfirmed(intent.requestId, "writing_start_history_unavailable")});}
    },
    startWriting: async request => {
      const value = this.record(request), { preview } = value;
      if (!value.workspace || !value.buffers || request.contextSnapshotId !== preview.contextSnapshotId
        || JSON.stringify(request.model) !== JSON.stringify(preview.input.model)) throw new Error("模拟副本或冻结模型不匹配");
      const alreadyStarted = value.started;
      if (!alreadyStarted) {
        const admission = { scope: { manuscriptId: this.manuscriptId, conversationId: preview.conversationId,
          requestId: preview.requestId, contextSnapshotId: preview.contextSnapshotId }, turnId: preview.turnId };
        this.agent.history.start(admission, preview.input.text, preview.input.model);
        if (this.singleTextResponse !== undefined) {
          value.started = true;
          this.startSingleResponse(value, admission, this.singleTextResponse);
          return decodeAgentWritingStartResponse({ schemaVersion: 1, conversationId: preview.conversationId,
            requestId: preview.requestId, turnId: preview.turnId, alreadyStarted, outcome: value.outcome });
        }
        if(this.historyOnly){
          value.started=true;
          return decodeAgentWritingStartResponse({schemaVersion:1,conversationId:preview.conversationId,requestId:preview.requestId,turnId:preview.turnId,alreadyStarted,outcome:value.outcome});
        }
        this.agent.history.resourceRound(admission,preview.input.userInput??[],preview.input.skillInstructions??[]);
        value.started = true;
        const project = value.request.resources?.find(resource => resource.kind === "manuscript" && resource.resourceId === this.manuscriptId);
        const frozen = structuredClone(project?.kind === "manuscript" ? value.buffers.filter(buffer => agentContextPathAccess(project,buffer.path,true)) : value.buffers);
        if ((this.multipleResponses || this.patchFailure) && frozen.length) value.responses = new WritingDemoResponseSequence(frozen, this.progressiveFeedback, this.responseTexts, this.readTextPacing, this.patchFailure);
        else if (this.progressiveFeedback) value.feedback = new WritingDemoFeedback({
          ...writingDemoPatch(admission.scope.manuscriptId, frozen.map(buffer => ({ path: buffer.path, kind: "modified", before: buffer.text,
            after: `${buffer.text}\n% Mock Agent: ${preview.input.text.replace(/[\r\n]+/gu, " ")}` }))),
          text: this.agent.tools.connected ? "修改已在执行副本中准备，正在保存文件。" : `已准备 ${frozen.length} 个文件的修改。`,
          phase: "commentary" }, this.readTextPacing);
        value.intervalMs = this.delayMs / (this.progressiveFeedback ? Math.max(1, value.responses?.remainingWaitSteps ?? value.feedback?.remainingWaitSteps ?? 1) : (value.responses?.remainingSteps ?? 0) + 1);
        const finish = () => {
          if(value.outcome!==null)return;
          if (value.responses ? value.responses.atModelBoundary : value.feedback ? value.feedback.atModelBoundary : true)
            for(const [id,input] of value.steers)this.commitSteer(value,id,input.text);
          if (value.responses?.remainingSteps) {
            if (value.responses.next(this.agent.history, admission)) value.reconnectFailures = 0;
            if (!value.responses.isStreaming) this.finishRetryAttempt(value, admission);
            this.schedule(value);
            return;
          }
          if (value.feedback?.remainingSteps) {
            if (value.feedback.next(this.agent.history, admission)) value.reconnectFailures = 0;
            if (!value.feedback.isStreaming && !value.feedback.remainingSteps) this.finishRetryAttempt(value, admission);
            this.schedule(value);
            return;
          }
          for(const input of value.steers.values()){
            const prompts=input.skillInstructions.filter(prompt=>{const identity=JSON.stringify(prompt.identity);if(value.injected.has(identity))return false;value.injected.add(identity);return true;});
            this.agent.history.resourceRound(admission,input.userInput,prompts);
          }
          const label = [preview.input.text,...[...value.steers.values()].map(input=>input.text)].join("；").replace(/[\r\n]+/gu, " ");
          this.finishRetryAttempt(value, admission);
          // This is simulated model output, never a second editor write path.
          const changes = value.responses?.changes() ?? frozen.map(buffer => ({ path: buffer.path, kind: "modified" as const,
            before: buffer.text, after: `${buffer.text}\n% Mock Agent: ${label}`, additions: 1, deletions: 0 }));
          void (changes.length && this.agent.tools.connected ? this.deliverFiles(value, admission, changes, frozen)
            : this.agent.complete(admission, changes, "completed", frozen, !!(value.responses || value.feedback)))
            .then(() => { if (!value.singleResponse) value.outcome = "completed"; })
            .catch(async () => { await this.agent.complete(admission, [], "failed"); value.outcome = "failed"; });
        };
        value.finish=finish;
        this.schedule(value);
      }
      return decodeAgentWritingStartResponse({ schemaVersion: 1, conversationId: preview.conversationId,
        requestId: preview.requestId, turnId: preview.turnId, alreadyStarted, outcome: value.outcome });
    },
  };
  readonly turns: AgentTurnGateway = { interrupt: async request => {
    const value = [...this.records.values()].find(item => item.preview.conversationId === request.conversationId
      && item.preview.turnId === request.turnId);
    if (!value?.started) throw new Error("模拟轮次不存在");
    const cancellationRequested = value.outcome === null && (value.timer !== undefined || this.historyOnly);
    if (value.timer !== undefined) {
      clearTimeout(value.timer); this.timers.delete(value.timer); delete value.timer;
    }
    if (cancellationRequested) {
      await this.agent.complete({ scope: { conversationId: value.preview.conversationId, requestId: value.preview.requestId,
        manuscriptId: this.manuscriptId, contextSnapshotId: value.preview.contextSnapshotId }, turnId: value.preview.turnId }, [], "canceled", [], this.historyOnly);
      value.outcome = "canceled";
    }
    return decodeAgentInterruptResponse({ schemaVersion: 1, ...request, cancellationRequested });
  } };
  readonly workspace: AgentWorkspaceGateway = {
    prepare: async ({ scope, buffers }) => {
      const value = this.record(scope);
      if (value.preview.contextSnapshotId !== scope.contextSnapshotId) throw new Error("模拟副本来源身份不匹配");
      if (value.workspace) {
        if (JSON.stringify(value.buffers) !== JSON.stringify(buffers)) throw new Error("模拟副本冻结内容冲突");
        return structuredClone(value.workspace);
      }
      const frozen = structuredClone(buffers);
      for (const buffer of frozen) {
        const input = value.preview.input.context.find(file => file.resourceId === buffer.path);
        if ((input && input.text !== buffer.text) || (await this.storage.files.readFile(this.manuscriptId, buffer.path)).sha256 !== buffer.expectedDiskSha256) throw new Error("模拟副本文件版本已过期");
      }
      const files = frozen.map(buffer => ({ path: buffer.path, byteSize: new TextEncoder().encode(buffer.text).byteLength, hasEditorBuffer: true }));
      value.workspace = decodeAgentWorkspacePreview({ schemaVersion: 1, ...scope, turnId: value.preview.turnId,
        leaseId: crypto.randomUUID(), manifestHash: await writingDiffDemoHash(JSON.stringify(frozen)),
        policy: "offline_workspace_v1", approved: false, files });
      value.buffers = frozen; return structuredClone(value.workspace);
    },
    restore: async scope => {const value = this.record(scope); if (!value.workspace) throw "notFound"; return this.readWorkspace(scope);},
    approve: async request => {
      const current = this.readWorkspace(request.scope);
      if (current.turnId !== request.turnId || current.leaseId !== request.leaseId || current.manifestHash !== request.manifestHash) throw new Error("模拟副本确认身份不匹配");
      const value = this.record(request.scope); value.workspace = { ...current, approved: true }; return structuredClone(value.workspace);
    },
    revoke: async request => {
      const current = this.readWorkspace(request.scope);
      if (current.turnId !== request.turnId || current.leaseId !== request.leaseId || current.manifestHash !== request.manifestHash) throw new Error("模拟副本撤回身份不匹配");
      this.record(request.scope).workspace = { ...current, approved: false };
    },
  };
  private readWorkspace(scope: AgentWorkspaceScope): AgentWorkspacePreview {
    const value = this.record(scope);
    if (!value.workspace || value.workspace.contextSnapshotId !== scope.contextSnapshotId) throw new Error("模拟副本不存在");
    return structuredClone(value.workspace);
  }
  dispose(): void { this.disposed = true; this.agent.tools.dispose(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}
