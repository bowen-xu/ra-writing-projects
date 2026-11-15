import type { ReadMessageInspection } from "@research-assistant/workbench-sdk/agent-presentation";
import type { AgentWritingQueueResponse, AgentWritingQueueScope, AgentWritingSteerRequest } from "@research-assistant/core/agent";
import type {
  AgentCatalogGateway, AgentCreationGateway, AgentForkGateway, AgentForkOriginGateway,
  AgentInputQueueGateway, AgentInputQueuePreviewGateway, AgentInputQueueRegistry,
  AgentMetadataGateway, AgentSteeringGateway, AgentSteeringHandoffRegistry, AgentSteeringRegistry, AgentSubmissionGateway,
  AgentSubtaskGateway, AgentTurnGateway, AgentWorkspaceGateway,
  AgentWritingCompactionGateway, AgentSessionGateway,
} from "@research-assistant/data/agent";
import type { AiAssistanceGateway } from "@research-assistant/workbench-sdk/ai-assistance";
import type { AgentModelGateway } from "@research-assistant/workbench-sdk/agent-context-controls";
import type { AgentResourceGateways } from "@research-assistant/workbench-sdk/agent-context-controls";
import type { AgentCommandGateway } from "@research-assistant/workbench-sdk/agent-submission";
import type { WritingWorkspaceReviewGateways } from "./WritingWorkspaceReview";
import type { AgentContextGateway } from "@research-assistant/workbench-sdk/agent-context-controls";
import type { AgentContextUsageReader } from "@research-assistant/workbench-sdk/agent-context-controls";

export interface WritingQueueAccess {
  readonly gateway: AgentInputQueueGateway;
  readonly registry: AgentInputQueueRegistry<AgentWritingQueueScope, AgentWritingQueueResponse>;
}

export type WritingSteeringScope = Omit<AgentWritingSteerRequest, "inputId" | "text">;
export interface WritingSteeringAccess {
  readonly send: AgentSteeringGateway["steerWriting"];
  readonly registry: AgentSteeringRegistry<WritingSteeringScope>;
}

/** Stable host-owned I/O ports for the production writing runtime. Registries
 * must outlive conversation views, just like the application's Agent providers.
 * A distinct identity prevents pending native and mock submissions from sharing
 * an owner, including when a preview resets its storage with the same file IDs.
 */
export interface WritingAgentRuntimeGateways {
  readonly compaction?: AgentWritingCompactionGateway;
  readonly history?: AgentSessionGateway;
  readonly contextUsage?: AgentContextUsageReader;
  readonly context?: AgentContextGateway;
  readonly identity: string;
  readonly submission: AgentSubmissionGateway;
  readonly turns: AgentTurnGateway;
  readonly queuePreview: AgentInputQueuePreviewGateway;
  readonly queue: WritingQueueAccess;
  readonly steering: WritingSteeringAccess;
  readonly steeringHandoff?: AgentSteeringHandoffRegistry;
  readonly workspace: AgentWorkspaceGateway;
  readonly creation: AgentCreationGateway;
  readonly metadata: AgentMetadataGateway;
  readonly catalog: Pick<AgentCatalogGateway, "rename" | "renameStatus">;
  readonly subtasks: Pick<AgentSubtaskGateway, "list" | "subscribe" | "reconcile" | "resumeWriting">;
  readonly fork: AgentForkGateway;
  readonly forkOrigin: AgentForkOriginGateway;
  readonly retrieval: Pick<AiAssistanceGateway, "previewConceptRetrieval" | "cancelConceptRetrievalPreview">;
  readonly model: AgentModelGateway;
  readonly messageInspection?: ReadMessageInspection;
  readonly resources?: AgentResourceGateways;
  readonly commands?: AgentCommandGateway;
  readonly review: Required<WritingWorkspaceReviewGateways>;
}
