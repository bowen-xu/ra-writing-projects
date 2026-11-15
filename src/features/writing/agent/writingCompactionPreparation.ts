import type { AgentWritingCompactionPrepareRequest } from "@research-assistant/core/agent";
import { captureWritingSubmissionSources } from "./writingSubmissionSources";
import type { WritingAgentSubmitOptions } from "@research-assistant/workbench-sdk/agent-presentation";
import type { WritingAgentRuntimeProps } from "./writingRuntimeProps";
import type { useContextContribution } from "@research-assistant/workbench-sdk/agent-context-controls";
import type { AgentSessionGateway } from "@research-assistant/data/agent";
import type { AgentUserInput } from "@research-assistant/core/agent";
import type { useWritingCompaction } from "./useWritingCompaction";

/** Host preparation only. Retry restores native's frozen preparation before
 * this function is considered; it never re-reads editor data for an existing R. */
export async function prepareWritingCompaction(options: {
  readonly host: WritingAgentRuntimeProps;
  readonly selection: WritingAgentSubmitOptions;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly current: () => boolean;
  readonly ensureConversation: () => Promise<boolean>;
  readonly contribution: Pick<ReturnType<typeof useContextContribution>, "ready" | "flush" | "selected">;
  readonly execute: (request: AgentWritingCompactionPrepareRequest) => Promise<boolean>;
}): Promise<boolean> {
  const { host, selection, requestId, contribution } = options;
  if (!host.manuscriptId || !host.conversationId || !(await options.ensureConversation()) || !options.current()) return false;
  const fileBuffers = await host.readFileBuffers?.();
  if (!options.current()) return false;
  const sources = captureWritingSubmissionSources({ manuscriptId: host.manuscriptId, files: host.files,
    contextScope: "current-file", activePath: host.activePath, content: host.content, contentHash: host.contentHash,
    editor: host.readEditorSnapshot?.() ?? null, fileBuffers });
  if (!contribution.ready) throw new Error("上下文尚未读取完成，请稍后重试。");
  await contribution.flush();
  if (!options.current()) return false;
  return options.execute({ expectedRevision: options.expectedRevision, request: {
    conversationId: host.conversationId, requestId, text: "/compact", userInput: [],
    resources: contribution.selected([], requestId),
    context: { manuscriptId: host.manuscriptId, files: sources.contextFiles },
    ...(selection.modelSelection ? { model: selection.modelSelection } : {}),
  } });
}

export async function prepareQueuedWritingCompaction(options: Omit<Parameters<typeof prepareWritingCompaction>[0], "execute" | "expectedRevision"> & {
  readonly history: AgentSessionGateway;
  readonly compaction: Pick<ReturnType<typeof useWritingCompaction>, "executeQueued">;
  readonly inputId: string;
  readonly previousRequestId: string | null;
  readonly expectedQueueRevision: number;
  readonly userInput: readonly AgentUserInput[];
  readonly onCaptured: () => void;
}): Promise<boolean> {
  if (!options.host.conversationId) return false;
  const history = await options.history.open(options.host.conversationId);
  if (!options.current()) return false;
  return prepareWritingCompaction({...options, expectedRevision: history.watermark,
    execute: request => { options.onCaptured(); return options.compaction.executeQueued({inputId: options.inputId, expectedQueueRevision: options.expectedQueueRevision,
      previousRequestId: options.previousRequestId, expectedRevision: request.expectedRevision,
      submission: {...request.request, userInput: options.userInput}}); }});
}
