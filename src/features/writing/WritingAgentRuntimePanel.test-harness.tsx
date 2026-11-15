// Import this harness before production modules so its gateway mocks register first.
// Each suite shares one registration boundary and owns its production imports.
import { createMockContextConfiguration } from "../../../../../apps/web/src/app/runtime/mock/mockContextConfiguration";
import type { AgentChildTaskSummary, AgentConversationProjection, AgentWritingQueueResponse, AgentSubmissionPreview, AgentWritingPrepareRequest } from "@research-assistant/core/agent";
import { beforeEach, vi, type Mock } from "vitest";
import { WritingAgentRuntimePanel as ProductionWritingAgentRuntimePanel, resetWritingRetrievalOwnersForTests } from "./WritingAgentRuntimePanel";
import { AgentSteeringProvider, useAgentSteeringOwners } from "../../../../../apps/web/src/core/features/agent/AgentSteeringProvider";
import { createAgentConversationProjection } from "@research-assistant/core/agent";
import { useMemo } from "react";
import type { WritingAgentRuntimeProps } from "./agent/writingRuntimeProps";
import { resetWritingSubmissionControllersForTests } from "../../../../../apps/web/src/core/features/agent/writingSubmissionController";
import { getAppStorage, selectAppStorage } from "../../../../../apps/web/src/core/runtime/appStorage";
import { notify } from "../../../../../apps/web/src/core/public/feedback";
import { creationProof } from "../../../../../apps/web/src/core/features/agent/conversationCreationTestFacts";
type RuntimeMocks = Record<"contextRead" | "contextSave" | "handoffRead" | "steer" | "readOrigin" | "fork" | "forkStatus" |
  "createBound" | "createBoundStatus" | "metadataRead" | "prepareWriting" | "prepareWritingStatus" | "restoreWriting" |
  "startWriting" | "interrupt" | "readWritingRecovery" | "rename" | "edit" | "prepare" |
  "cancel" | "cancelStatus" | "prepareStatus" | "recover" | "list" | "start" | "startStatus", Mock> & {
    read: Mock<() => Promise<AgentWritingQueueResponse>>;
    childList: Mock<() => Promise<AgentChildTaskSummary[]>>;
    resumeWriting: Mock<() => Promise<void>>;
    reconcile: Mock<() => Promise<AgentChildTaskSummary>>;
  };
const mocks: RuntimeMocks = vi.hoisted(() => ({
  contextRead: vi.fn(), contextSave: vi.fn(), handoffRead: vi.fn(), steer: vi.fn(),
  readOrigin: vi.fn(async () => ({ schemaVersion: 1, conversationId: "parent", origin: null })),
  fork: vi.fn(), forkStatus: vi.fn(), createBound: vi.fn(), createBoundStatus: vi.fn(), metadataRead: vi.fn(),
  prepareWriting: vi.fn(), prepareWritingStatus: vi.fn(), restoreWriting: vi.fn(), startWriting: vi.fn(), interrupt: vi.fn(),
  readWritingRecovery: vi.fn(), rename: vi.fn(),
  read: vi.fn(async (): Promise<AgentWritingQueueResponse> => ({
    schemaVersion: 1, conversationId: "11111111-1111-4111-8111-111111111111",
    manuscriptId: "11111111-1111-4111-8111-111111111111", revision: 0,
    paused: false, preparingInputId: null, inputs: [],
  })),
  edit: vi.fn(), prepare: vi.fn(), cancel: vi.fn(), prepareStatus: vi.fn(), cancelStatus: vi.fn(), recover: vi.fn(), list: vi.fn(), start: vi.fn(), startStatus: vi.fn(),
  childList: vi.fn(async (): Promise<AgentChildTaskSummary[]> => []),
  resumeWriting: vi.fn(async (): Promise<void> => undefined),
  reconcile: vi.fn(async (): Promise<AgentChildTaskSummary> => { throw new Error("unused"); }),
}));
const workspace: Record<"prepare" | "restore" | "approve" | "revoke", Mock> =
  vi.hoisted(() => ({ prepare: vi.fn(), restore: vi.fn(), approve: vi.fn(), revoke: vi.fn() }));
const retrieval = vi.hoisted(() => ({
  preview: vi.fn(async () => ({ traceId: "trace-writing", semanticStatus: "used" as const, seeds: [], edges: [], sources: [], selectedSourceCount: 0, externalPaperCount: 0, contextSha256: "a".repeat(64), expiresAt: "later" })),
  cancel: vi.fn(async () => true),
}));
vi.mock("../../../../../apps/web/src/core/services/agentGateway", () => ({
  agentCompactionGateway: { prepareWriting: vi.fn(), restoreWriting: vi.fn(), start: vi.fn(), prepareWritingQueued: vi.fn(), settleWritingQueued: vi.fn(),
    readWritingQueued: vi.fn(async request => {const preview = await mocks.recover(request); return preview ? {schemaVersion: 1, kind: "submission", preview} : null;}) },
  agentSessionGateway: { create: vi.fn(), open: vi.fn(), read: vi.fn(), tail: vi.fn() },
  agentHostResourceGateway: vi.fn(async () => []),
  agentMcpGateway: { list: vi.fn(async () => []), install: vi.fn(), revoke: vi.fn() },
  agentSkillCatalogGateway: {
    list: vi.fn(async () => ({ schemaVersion: 1, environmentId: "application", skills: [], errors: [] })),
    setEnabled: vi.fn(),
  },
  agentSteeringGateway: { steerWriting: mocks.steer },
  agentForkOriginGateway: { read: mocks.readOrigin }, agentForkGateway: { fork: mocks.fork, status: mocks.forkStatus },
  agentCreationGateway: { createBound: mocks.createBound, createBoundStatus: mocks.createBoundStatus },
  agentWorkspaceReviewGateway: mocks,
  agentProposalGateway: {
    latest: vi.fn(async () => null), publish: vi.fn(), review: vi.fn(), reject: vi.fn(), readFile: vi.fn(),
  },
  agentWorkspaceGateway: workspace, agentSubmissionGateway: mocks, agentTurnGateway: mocks,
  agentSteeringRecoveryGateway: mocks, agentInputQueueGateway: mocks, agentNoteQueueGateway: mocks,
  agentPaperQueueGateway: mocks, agentInputQueuePreviewGateway: mocks, agentQueueAdmissionsGateway: mocks,
  agentCatalogGateway: { rename: mocks.rename },
  agentChildCreationStatusGateway: { read: vi.fn() },
  agentSubtaskGateway: { list: mocks.childList, resumeWriting: mocks.resumeWriting, reconcile: mocks.reconcile },
  agentMetadataGateway: { read: mocks.metadataRead },
}));
vi.mock("../../../../../apps/web/src/core/services/agentContextGateway", () => ({ agentContextGateway: {
  sessions: { create: vi.fn() }, list: vi.fn(async () => []), search: vi.fn(async () => []),
  catalog: vi.fn(async () => []), readConfiguration: mocks.contextRead, saveConfiguration: mocks.contextSave,
  steeringHandoff: {read: mocks.handoffRead,
    prepare: async () => {throw new Error("Unexpected handoff");}, resolution: async () => {throw new Error("Unexpected handoff");},
    finish: async () => {throw new Error("Unexpected handoff");}, release: async () => {throw new Error("Unexpected handoff");}, cancelUnregistered: async () => {throw new Error("Unexpected handoff");}},
} }));
vi.mock("../../../../../apps/web/src/core/features/agent/presentation/WritingAgentModelControl", () => ({ WritingAgentModelControl: () => null }));
vi.mock("../../../../../apps/web/src/core/features/speech/PaperAiReadingSpeechInput", () => ({ PaperAiReadingSpeechInput: () => null, speechInputStateLabel: () => "" }));
vi.mock("../../../../../apps/web/src/core/services/aiAssistanceGateway", () => ({
  getAiAssistanceGateway: () => ({ previewConceptRetrieval: retrieval.preview, cancelConceptRetrievalPreview: retrieval.cancel }),
  aiAssistanceErrorMessage: (reason: unknown) => reason instanceof Error ? reason.message : String(reason),
}));
const id = "11111111-1111-4111-8111-111111111111";
const runningProjection: AgentConversationProjection = { conversationId: id, seq: 1, activeTurn: "turn", turnOrder: ["turn"], turns: new Map([["turn", {
  contextSnapshotId: "context", model: { providerId: "test", modelId: "test", revision: null }, phase: "runningModel", outcome: null,
  itemOrder: [], items: new Map(), attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null,
}]]) };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.createBound.mockImplementation(async request => creationProof(request));
  mocks.createBoundStatus.mockImplementation(async request => ({ schemaVersion: 1, operationId: request.operationId, conversationId: request.id, status: { type: "committed", proof: creationProof(request) } }));
  mocks.metadataRead.mockImplementation(async (request: { id: string }) => ({ id: request.id, title: "Child", archived: false, durableCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
  mocks.handoffRead.mockImplementation(async (conversationId: string) => ({schemaVersion: 1, conversationId, epoch: "99999999-9999-4999-8999-999999999999", items: []}));
  vi.spyOn(notify,"error");
  resetWritingSubmissionControllersForTests(); resetWritingRetrievalOwnersForTests();
  const values = new Map<string, string>();
  selectAppStorage({get length(){return values.size;}, key:index=>[...values.keys()][index]??null,
    getItem:key=>values.get(key)??null, setItem:(key,value)=>{values.set(key,value);},
    removeItem:key=>{values.delete(key);}, clear:()=>values.clear()});
  const context=createMockContextConfiguration(getAppStorage());mocks.contextRead.mockImplementation(context.readConfiguration!);mocks.contextSave.mockImplementation(context.saveConfiguration!);
});
function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
}
function submissionContext(request: AgentWritingPrepareRequest): AgentSubmissionPreview["input"]["context"] {
  return request.context.files.map(file => ({sourceId: `file:${file.relativePath}`, kind: "manuscript", resourceId: file.relativePath,
    revision: file.buffer?.revision ?? file.expectedDiskSha256, anchor: JSON.stringify({manuscriptId: request.context.manuscriptId}), text: file.buffer?.text ?? "frozen source"}));
}
/** Legacy isolated tests model an empty loaded history with null. Supply an
 * empty projection so the production handoff owner can prove its read boundary. */
function WritingAgentRuntimePanel(props: WritingAgentRuntimeProps): React.JSX.Element {
  const owners = useAgentSteeringOwners();
  const empty = useMemo(() => createAgentConversationProjection(props.conversationId ?? id), [props.conversationId]);
  const panel = <ProductionWritingAgentRuntimePanel {...props} projection={props.projection ?? (props.historyReady ? empty : null)} />;
  return owners ? panel : <AgentSteeringProvider>{panel}</AgentSteeringProvider>;
}
export { mocks, workspace, retrieval, id, runningProjection, buttonByText, submissionContext, WritingAgentRuntimePanel };
