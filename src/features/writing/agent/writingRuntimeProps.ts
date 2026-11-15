import type { ReactNode } from "react";
import type { AgentConversationProjection, AgentConversationSummary, AgentWorkspaceBuffer } from "@research-assistant/core/agent";
import type { ManuscriptFile } from "@research-assistant/writing";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { ReadWritingEditorSnapshot } from "../editor/editorSession";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-sdk/agent-writing";
import type { AgentMessageSearchTarget } from "@research-assistant/workbench-sdk/agent-conversations";
import type { WritingAgentRuntimeGateways } from "./writingRuntimeGateways";
import type { WritingAgentTaskStackProps } from "@research-assistant/workbench-sdk/agent-presentation";
import type { WritingAgentMessage } from "@research-assistant/workbench-sdk/agent-presentation";

export interface WritingAgentRuntimeProps {
  readonly messageRequest?: import("@research-assistant/workbench-sdk/agent-ui").AgentCanvasMessage | null;
  readonly headerControls?: ReactNode;
  readonly showLauncher?: boolean;
  readonly dismissOnOutsideClick?: boolean;
  readonly undoProposal?: import("./writingCardUndo").UndoWritingProposal;
  readonly gateways?: WritingAgentRuntimeGateways;
  readonly onSubmissionAdmitted?: (value: WritingSubmissionAdmission) => void;
  /** Immutable per-turn delivery outcomes; pending file work does not lock chat. */
  readonly fileDeliveries?: readonly import("./WritingAgentFileDelivery").WritingAgentDeliverySnapshot[];
  readonly taskGoal?:WritingAgentTaskStackProps["goal"];
  readonly onOpenConversation?: (conversation: AgentConversationSummary, throughTurnId?: string) => void;
  readonly searchTarget?: AgentMessageSearchTarget | null;
  readonly historyError?: boolean;
  /** File-owner failure uses the shared conversation error presentation. */
  readonly hostFailure?: {readonly content: string; readonly diagnosticText?: string; readonly retry?: () => void} | undefined;
  readonly readEditorSnapshot?: ReadWritingEditorSnapshot;
  readonly readFileBuffers?: () => readonly AgentWorkspaceBuffer[] | Promise<readonly AgentWorkspaceBuffer[]>;
  readonly manuscriptId: string | undefined;
  readonly conversationId: string | null;
  /** A locally selected conversation identity that is persisted on first send. */
  readonly pendingConversationId?: string | null;
  readonly onConversationCreated?: (conversation: AgentConversationSummary) => void;
  readonly onConversationCreationFinished?: () => void;
  readonly archived?: boolean;
  readonly metadataUnavailable?: string | undefined;
  readonly metadataLoading?: boolean;
  readonly onRetryMetadata?: () => void;
  readonly onConversationTitleChanged?: (conversation: AgentConversationSummary) => void;
  readonly conversationTitle?: string | undefined;
  readonly activePath: string | undefined;
  readonly content: string;
  readonly contentHash: string | undefined;
  readonly files: readonly ManuscriptFile[];
  readonly messages: readonly WritingAgentMessage[];
  readonly projection: AgentConversationProjection | null;
  readonly historyReady: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly fileSessions?: WritingFileSessions;
  readonly onJumpToEditor?: (path: string) => void;
}
