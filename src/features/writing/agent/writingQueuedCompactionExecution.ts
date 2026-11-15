import type { AgentUserInput, AgentWritingQueueResponse } from "@research-assistant/core/agent";
import type { useWritingCompaction } from "./useWritingCompaction";
import type { useWritingInputQueue } from "./useWritingInputQueue";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { writingCompactionDiagnostic } from "./WritingCompactionFeedback";

interface Options {
  readonly compaction: ReturnType<typeof useWritingCompaction>;
  readonly conversationId: string;
  readonly manuscriptId: string;
  readonly inputId: string;
  readonly explicit: boolean;
  readonly current: () => boolean;
  readonly queueController: ReturnType<typeof useWritingInputQueue>["controller"];
  readonly capture: (requestId: string, previousRequestId: string | null, queueRevision: number, userInput: readonly AgentUserInput[]) => Promise<boolean>;
}
/** I identifies one queued command. Only an explicit action after a native
 * terminal or proved unstarted retirement may create another R. */
export async function executeWritingQueuedCompaction(options: Options): Promise<boolean> {
  const {compaction, inputId, current, explicit} = options;
  const reload = () => options.queueController.current?.reload() ?? Promise.resolve();
  const readQueue = (): AgentWritingQueueResponse | null | undefined => options.queueController.current?.getSnapshot().queue;
  const saved = compaction.savedQueued();
  if (saved) return saved.inputId === inputId ? compaction.retry() : false;
  const prior = await compaction.readQueued({conversationId: options.conversationId, manuscriptId: options.manuscriptId, inputId, requestId: null});
  if (!current() || prior?.kind === "submission") return false;
  let previousRequestId: string | null = null;
  if (prior?.kind === "compact") {
    if (!prior.outcome && !prior.retirement) return prior.current ? compaction.recoverQueued(inputId, prior.requestId, explicit) : false;
    // A released terminal keeps its immutable intent after the claim pointer is
    // removed. Re-settling that claim would race a later edit of the same I.
    const completed = prior.current || prior.retirement ? await compaction.recoverQueued(inputId, prior.requestId, !prior.retirement) : false;
    await reload();
    if (prior.outcome === "completed") return completed;
    if (!explicit || !current() || compaction.isPending()) return false;
    previousRequestId = prior.requestId;
    const held = readQueue(), controller = options.queueController.current;
    if (!controller || !held) return false;
    if ((held.paused || held.inputs.find(input => input.inputId === inputId)?.paused)
      && !(await controller.edit({type: "resumeInput", inputId}))) return false;
    if (!current()) return false;
  }
  await reload();
  if (!current()) return false;
  const queue = readQueue(), input = queue?.inputs.find(item => item.inputId === inputId);
  if (!queue || !input || queue.preparingInputId || queue.paused || input.paused || queue.inputs.find(item => !item.paused)?.inputId !== inputId) return false;
  return options.capture(crypto.randomUUID(), previousRequestId, queue.revision, input.userInput ?? []);
}

export async function recoverWritingQueueCompaction(compaction: ReturnType<typeof useWritingCompaction>,
  scope: {conversationId: string; manuscriptId: string}, inputId: string,
  queueController: ReturnType<typeof useWritingInputQueue>["controller"]): Promise<boolean> {
  const original = queueController.current;
  try {
    const result = await compaction.readQueued({...scope, inputId, requestId: null});
    if (queueController.current !== original) return true;
    if (result?.kind !== "compact") return false;
    await compaction.recoverQueued(inputId, result.requestId);
    await original?.reload(); return true;
  } catch (cause: unknown) {
    if (queueController.current === original) notify.error(`读取原队列执行记录失败，请重试核对。${writingCompactionDiagnostic(cause)}（C=${scope.conversationId}；I=${inputId}）`);
    // Failed discovery is not evidence of an ordinary pending submission.
    return true;
  }
}
