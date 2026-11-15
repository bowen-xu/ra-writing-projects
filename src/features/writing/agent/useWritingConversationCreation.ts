import { useRef } from "react";
import type { AgentConversationSummary } from "@research-assistant/core/agent";
import type { ConversationDraftStore } from "@research-assistant/workbench-sdk/agent-drafts";
import { useBoundConversationCreation } from "@research-assistant/workbench-sdk/agent-conversations";
import { agentCreationGateway, agentMetadataGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import type { WritingAgentRuntimeProps } from "./writingRuntimeProps";
import { useAgentMountedGuard } from "@research-assistant/workbench-sdk/agent-presentation";
import {useWritingRuntimeAdmission} from "../persistence/writingRuntimeAdmission";

export function useWritingConversationCreation(props: WritingAgentRuntimeProps & { readonly drafts: ConversationDraftStore }, pending: boolean,
  lifecycle: React.MutableRefObject<number>) {
  const admission = useWritingRuntimeAdmission();
  const creation = useBoundConversationCreation(props.manuscriptId ? { kind: "manuscript", resourceId: props.manuscriptId } : null,
    { creation: props.gateways?.creation ?? agentCreationGateway, metadata: props.gateways?.metadata ?? agentMetadataGateway });
  const mounted = useAgentMountedGuard();
  const current = useRef({ id: props.conversationId, manuscriptId: props.manuscriptId, pending, archived: props.archived });
  current.current = { id: props.conversationId, manuscriptId: props.manuscriptId, pending, archived: props.archived };
  function adopt(conversation: AgentConversationSummary | null, epoch = lifecycle.current): boolean {
    const scope = current.current;
    if (!mounted.current || !conversation || conversation.archived || scope.archived || !scope.pending || !scope.manuscriptId
      || scope.id !== conversation.id || lifecycle.current !== epoch) return false;
    return creation.consumeAdoption(() => {
      props.drafts.adoptPending({ hostKind: "manuscript", hostId: scope.manuscriptId! }, conversation.id);
      props.onConversationCreated?.(conversation); return true;
    });
  }
  async function ensureConversation(): Promise<boolean> {
    if (!pending) return true;
    if (admission.isDisabled()) return false;
    if (!props.conversationId || !props.manuscriptId) return false;
    const epoch = lifecycle.current;
    return adopt(await creation.submit(props.conversationId), epoch);
  }
  function finished(): void {
    const scope = current.current;
    if (scope.pending && scope.id === creation.state?.intent?.id && scope.manuscriptId === props.manuscriptId) props.onConversationCreationFinished?.();
  }
  const captureAdoption = () => { const epoch = lifecycle.current; return (conversation: AgentConversationSummary | null) => { adopt(conversation, epoch); }; };
  return { creation, ensureConversation, captureAdoption, finished };
}
