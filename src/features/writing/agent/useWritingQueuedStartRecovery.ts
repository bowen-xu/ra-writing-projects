import {useEffect, type RefObject} from "react";
import type {AgentInputQueueGateway} from "@research-assistant/data/agent";
import {writingQueuedStartQueue} from "@research-assistant/workbench-sdk/agent-writing";
import type {WritingSubmissionAdmission, WritingSubmissionController} from "@research-assistant/workbench-sdk/agent-writing";
/** Restored intents stay pending until explicit read-only inspection. */
export function useWritingQueuedStartRecovery({controller, acquireQueue, gateway, onAdmitted}: {
  readonly controller: RefObject<WritingSubmissionController | null>;
  readonly acquireQueue: Parameters<typeof writingQueuedStartQueue>[0];
  readonly gateway: AgentInputQueueGateway;
  readonly onAdmitted: ((value: WritingSubmissionAdmission) => void) | undefined;
}) {
  useEffect(() => {
    const owner = controller.current; if (!owner) return;
    owner.configureQueuedStart(writingQueuedStartQueue(acquireQueue, scope => gateway.read(scope)), onAdmitted);
  }, [controller, acquireQueue, gateway, onAdmitted]);
}
