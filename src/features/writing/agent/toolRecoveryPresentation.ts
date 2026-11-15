import { agentTurnUnconfirmedChildCreations, type AgentConversationProjection } from "@research-assistant/core/agent";
import { agentFailureDiagnostics } from "@research-assistant/workbench-sdk/agent-diagnostics";
import type { WritingAgentMessage } from "@research-assistant/workbench-sdk/agent-presentation";

/** Keep a fallback whenever the visible transcript does not cover every recovery barrier.
 * History and rendered messages may temporarily refer to different revisions. */
export function addToolRecoveryFallbacks(projection: AgentConversationProjection, messages: readonly WritingAgentMessage[]): readonly WritingAgentMessage[] {
  const result = [...messages];
  const order = new Map(projection.turnOrder.map((id, index) => [id, index]));
  for (const [turnId, turn] of projection.turns) {
    const visible = messages.filter(message => message.conversationId === projection.conversationId && message.turnId === turnId);
    let uncovered = [...(turn.pendingToolReceipts ?? [])].some(callId =>
      !visible.some(message => message.failure && message.unconfirmedToolReceiptIds?.includes(callId)));
    if (turn.outcome !== null) {
      const children = agentTurnUnconfirmedChildCreations(turn);
      for (const item of turn.items.values()) {
        if (item.kind.type !== "toolCall" || !(item.accepted || turn.failure?.category === "recovery") || !item.completed) continue;
        const callId = item.kind.callId;
        if ([...turn.items.values()].some(result => result.completed && result.kind.type === "toolResult" && result.kind.callId === callId)) continue;
        const child = children.find(value => value.callId === callId);
        if (!child || !visible.some(message => message.childCreationRecovery?.some(identity =>
          identity.conversationId === projection.conversationId && identity.turnId === turnId && identity.callId === callId
          && identity.childId === child.childId && identity.operationId === child.operationId
          && identity.submissionRequestId === child.submissionRequestId && identity.watermark >= projection.seq))) uncovered = true;
      }
    }
    if (!uncovered) continue;
    const fallback: WritingAgentMessage = {id: `${turnId}/tool-recovery-fallback`, conversationId: projection.conversationId,
      turnId, role: "assistant", failure: true, turnFinished: turn.outcome !== null,
      ...(turn.outcome === null ? {} : {turnOutcome: turn.outcome}),
      content: `工具操作尚待核对，请勿重复提交。 [code=TOOL_RECOVERY_REQUIRED；C=${projection.conversationId}；T=${turnId}]`,
      failureDiagnosticText: agentFailureDiagnostics(projection.conversationId, turnId, turn)};
    let lastInTurn = -1;
    for (const [index, message] of result.entries()) {
      if (message.conversationId === projection.conversationId && message.turnId === turnId) lastInTurn = index;
    }
    const nextTurn = result.findIndex(message => message.conversationId === projection.conversationId && message.turnId !== undefined
      && (order.get(message.turnId) ?? Number.MAX_SAFE_INTEGER) > (order.get(turnId) ?? Number.MAX_SAFE_INTEGER));
    const position = lastInTurn >= 0 ? lastInTurn + 1 : nextTurn >= 0 ? nextTurn : result.length;
    result.splice(position, 0, fallback);
  }
  return result;
}
