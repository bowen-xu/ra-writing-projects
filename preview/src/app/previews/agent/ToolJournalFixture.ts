import type {AgentEvent, AgentEventPayload} from "@research-assistant/core/agent";
import type {StructuredResource} from "@research-assistant/core/structured-resources";
import {getAppRuntime} from "@research-assistant/workbench-preview/app-runtime";
import {decodeMockState, encodeMockState, flushStorage} from "@research-assistant/workbench-preview/storage";
import type {MockInternalToolStep} from "../../runtime/mock/mockInternalToolStep";
import {MockIndependentAgents} from "../../runtime/mock/MockIndependentAgents";
import {WritingDiffDemoHistory} from "@research-assistant/workbench-preview/writing-diff-demo-history";
import {seedDemoToolHistory} from "@research-assistant/workbench-preview/writing-demo-tool-history";

export interface ToolJournalFixture {
  readonly steps: readonly MockInternalToolStep[];
  readonly prompt?: string;
  readonly response?: string;
  readonly resources?: readonly StructuredResource[];
  readonly currentResources?: readonly StructuredResource[];
  readonly developerMode?: boolean;
  readonly outcome?: "completed" | "failed" | "canceled";
  readonly sourceTitles?: {readonly paperId: string; readonly noteId: string; readonly manuscriptId: string};
  readonly pendingStep?: Omit<MockInternalToolStep, "output">;
  readonly commentaryBefore?: string;
  readonly commentaryAfter?: string;
  readonly waitingForModel?: boolean;
}

type HistorySnapshot = ReturnType<WritingDiffDemoHistory["snapshot"]>;
export type ToolJournalStep = MockInternalToolStep;
const fixtureKey = "test-tool-conversation";

function previewRuntime() {
  const runtime = getAppRuntime();
  if (runtime.mode !== "preview" || !runtime.preview) throw new Error("Tool fixture requires the isolated App preview");
  return {...runtime, preview: runtime.preview};
}

/** Synthetic journal I/O only. The App owns every rendered production control. */
export async function seedToolJournal(data: ToolJournalFixture): Promise<string> {
  const runtime = previewRuntime();
  runtime.preview.configure({delayMs: 0, nextFailure: null});
  const agents = new MockIndependentAgents(runtime.storage, runtime.preview);
  const conversationId = crypto.randomUUID();
  await agents.seedConversation({schemaVersion: 1, conversationId,
    requestId: crypto.randomUUID(), turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(),
    input: {text: data.prompt ?? "检查工具执行记录", context: [], reasoningEffort: null,
      model: {providerId: "fixture", modelId: "tool-journal", revision: "1"}}},
  `工具执行记录 ${conversationId.slice(0, 8)}`, data.response ?? "工具执行记录已保存。", false,
  {steps: [...data.steps, ...(data.pendingStep ? [{...data.pendingStep, output: {status: "complete"}}] : [])], outcome: data.outcome ?? "completed"});
  if (data.commentaryBefore || data.commentaryAfter) {
    const snapshot = decodeMockState<HistorySnapshot>(runtime.storage.getItem("independent-history")!);
    const events = snapshot.events.get(conversationId)!;
    const start = events.findIndex(event => event.payload.type === "phaseChanged" && event.payload.phase === "runningTools");
    if (start < 0) throw new Error("Commentary fixture needs a tool step");
    const sample = events[start]!;
    const turnId = sample.payload.turnId;
    const commentary = (text: string): readonly AgentEvent[] => {
      const itemId = crypto.randomUUID();
      const payloads: readonly AgentEventPayload[] = [
        {type: "itemStarted", turnId, itemId, kind: {type: "assistantMessage"}},
        {type: "itemPhaseChanged", turnId, itemId, phase: "commentary"},
        {type: "textDelta", turnId, itemId, text}, {type: "itemCompleted", turnId, itemId},
      ];
      return payloads.map(payload => ({...sample, payload}));
    };
    let seeded = data.commentaryBefore ? [...events.slice(0, start), ...commentary(data.commentaryBefore), ...events.slice(start)] : events;
    if (data.commentaryAfter) {
      const end = seeded.map(event => event.payload.type === "itemStarted" && event.payload.kind.type === "assistantMessage").lastIndexOf(true);
      seeded = [...seeded.slice(0, end), ...commentary(data.commentaryAfter), ...seeded.slice(end)];
    }
    snapshot.events.set(conversationId, seeded.map((event, index) => ({...event, seq: index + 1})));
    runtime.storage.setItem("independent-history", encodeMockState(snapshot));
  }
  runtime.storage.setItem(fixtureKey, conversationId);
  runtime.storage.removeItem("research-assistant:independent-selected");
  runtime.storage.removeItem("research-assistant:conversation-pending");
  runtime.storage.setItem("research-assistant.developer-mode", String(data.developerMode ?? false));
  await flushStorage(runtime.storage);
  return conversationId;
}

function fixtureConversationId(): string {
  const id = previewRuntime().storage.getItem(fixtureKey);
  if (!id) throw new Error("Synthetic tool conversation unavailable");
  return id;
}

async function readToolEvents(): Promise<readonly AgentEvent[]> {
  const sessions = previewRuntime().gateways.agentContextGateway!.sessions;
  const conversationId = fixtureConversationId();
  const events: AgentEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await sessions.readHistory({conversationId, afterSeq, limit: 100});
    events.push(...page.events);
    if (page.nextAfterSeq === null) return events;
    afterSeq = page.nextAfterSeq;
  }
}

/** Replay an actual journal prefix through the existing finite mock reader. */
export async function preparePendingToolJournal(waitingForModel: boolean): Promise<void> {
  const runtime = previewRuntime(), events = await readToolEvents();
  const lastCall = [...events].reverse().find(event => event.payload.type === "itemStarted" && event.payload.kind.type === "toolCall");
  if (lastCall?.payload.type !== "itemStarted") throw new Error("Pending fixture needs a tool call");
  const itemId = lastCall.payload.itemId;
  const end = waitingForModel ? events.map(event => event.payload.type === "itemStarted" && event.payload.kind.type === "assistantMessage").lastIndexOf(true)
    : events.findIndex(event => event.payload.type === "itemCompleted" && event.payload.itemId === itemId);
  const history = new WritingDiffDemoHistory(), snapshot = history.snapshot();
  snapshot.events.set(fixtureConversationId(), events.slice(0, end));
  history.restore(snapshot);
  for (const gateway of new Set([runtime.gateways.agentContextGateway!.sessions, runtime.gateways.agentSessionGateway!])) {
    gateway.readHistory = history.gateway.readHistory;
    gateway.waitForHistory = history.gateway.waitForHistory;
  }
}

/** Read-only source metadata and immutable versions for the normal App hints. */
export async function configureToolResources(data: ToolJournalFixture): Promise<void> {
  const runtime = previewRuntime(), resources = data.resources ?? [];
  const current = new Map((data.currentResources ?? resources).map(resource => [resource.id, resource]));
  const gateway = runtime.gateways.getStructuredResourceGateway!;
  gateway.get = async id => {
    const resource = current.get(id);
    if (!resource) throw new Error("Synthetic structured object unavailable");
    return resource;
  };
  gateway.getVersion = async (id, revision) => {
    const resource = resources.find(item => item.id === id && item.revision === revision);
    if (!resource) throw new Error("Synthetic immutable revision unavailable");
    return resource;
  };
  gateway.list = async () => [...current.values()];
  gateway.review = async request => {
    const previous = current.get(request.resourceId)!;
    const resource = {...previous, revision: previous.revision + 1, content: null, pendingFieldIds: []};
    current.set(request.resourceId, resource);
    return resource;
  };
  const literature = runtime.gateways.getLiteratureGateway!;
  const templatePaper = (await literature.list())[0]!;
  const getPaper = literature.get.bind(literature);
  literature.get = async id => resources.some(resource => resource.paperId === id) || id === data.sourceTitles?.paperId
    ? {...templatePaper, id, title: "论文甲", attachments: []} : getPaper(id);
  if (data.sourceTitles) {
    const ids = data.sourceTitles, notes = runtime.gateways.getNotesGateway!;
    const templateNote = await notes.loadDocument((await notes.listPages())[0]!.id);
    const load = notes.loadDocument.bind(notes);
    notes.loadDocument = async id => id === ids.noteId ? {...templateNote, page: {...templateNote.page, id, title: "实验笔记"}} : load(id);
    const writing = runtime.gateways.getWritingGateway!;
    const manuscripts = writing.listManuscripts.bind(writing);
    const templateManuscript = (await manuscripts())[0]!;
    writing.listManuscripts = async () => [...await manuscripts(), {...templateManuscript, id: ids.manuscriptId, title: "稿件甲"}];
  }
}

export async function readToolHistoryCallIds(): Promise<readonly string[]> {
  const events = await readToolEvents();
  const results = new Set(events.flatMap(event => event.payload.type === "itemStarted" && event.payload.kind.type === "toolResult" ? [event.payload.kind.callId] : []));
  return events.flatMap(event => event.payload.type === "itemStarted" && event.payload.kind.type === "toolCall" && results.has(event.payload.kind.callId) ? [event.payload.kind.callId] : []);
}

/** Select an actual Writing mock, preserving its original event-data reader. */
export async function selectWritingJournal(options: {readonly developerMode: boolean; readonly fresh: boolean}): Promise<void> {
  const runtime = previewRuntime();
  runtime.preview.configure({delayMs: 0, nextFailure: null});
  let id: string;
  if (options.fresh) {
    const manuscript = await runtime.gateways.getWritingGateway!.createManuscript({title: "合成写作检查"});
    id = crypto.randomUUID();
    await runtime.gateways.agentCreationGateway!.createBound({id, operationId: crypto.randomUUID(), binding: {kind: "manuscript", resourceId: manuscript.id}});
  } else {
    const manuscriptId = runtime.storage.getItem("initial-manuscript");
    const bindings = JSON.parse(runtime.storage.getItem("agent-bindings")!) as readonly (readonly string[])[];
    const selected = bindings.find(binding => binding[1] === manuscriptId)?.[0];
    if (!selected) throw new Error("Synthetic writing conversation unavailable");
    id = selected;
  }
  runtime.storage.setItem("research-assistant:independent-selected", id);
  runtime.storage.setItem("research-assistant.developer-mode", String(options.developerMode));
  await flushStorage(runtime.storage);
}

/** Reuse the existing event-only history fixture and its exact tool payloads. */
export function originalToolHistorySteps(): readonly MockInternalToolStep[] {
  const history = new WritingDiffDemoHistory();
  const admission = {scope: {manuscriptId: "independent", conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID()}, turnId: crypto.randomUUID()};
  history.start(admission, "检查工具执行记录");
  seedDemoToolHistory(history, admission, false);
  const events = history.snapshot().events.get(admission.scope.conversationId)!;
  const text = (itemId: string): string => events.flatMap(event => event.payload.type === "textDelta" && event.payload.itemId === itemId ? [event.payload.text] : []).join("");
  return events.flatMap(event => {
    if (event.payload.type !== "itemStarted" || event.payload.kind.type !== "toolCall") return [];
    const call = event.payload, kind = event.payload.kind;
    const result = events.find(value => value.payload.type === "itemStarted" && value.payload.kind.type === "toolResult" && value.payload.kind.callId === kind.callId);
    if (result?.payload.type !== "itemStarted" || result.payload.kind.type !== "toolResult") throw new Error("Synthetic tool result unavailable");
    return [{name: kind.name, arguments: JSON.parse(text(call.itemId)) as unknown, output: JSON.parse(text(result.payload.itemId)) as unknown,
      ...(result.payload.kind.isError ? {isError: true} : {})}];
  });
}
