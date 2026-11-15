import { useMemo } from "react";
import { agentInputQueueGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { useAgentInputQueue } from "@research-assistant/workbench-sdk/agent-submission";
import { useAgentQueueOwners } from "@research-assistant/workbench-sdk/agent-submission";
import type { WritingQueueAccess } from "./writingRuntimeGateways";

export function useWritingInputQueue(manuscriptId: string | undefined, conversationId: string | null, ready: boolean, access?: WritingQueueAccess) {
  const owners = useAgentQueueOwners();
  const scope = useMemo(() => manuscriptId && conversationId ? { manuscriptId, conversationId } : null, [manuscriptId, conversationId]);
  return useAgentInputQueue(access?.gateway ?? agentInputQueueGateway, scope, ready, 0, access?.registry ?? owners?.writing);
}
