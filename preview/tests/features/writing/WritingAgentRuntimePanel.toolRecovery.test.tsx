/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it} from "vitest";
import {id, WritingAgentRuntimePanel} from "./WritingAgentRuntimePanel.test-harness.tsx";
import {applyAgentEvents, createAgentConversationProjection, decodeAgentEvent, type AgentEventPayload} from "@research-assistant/core/agent";
import {projectConversationMessages} from "@research-assistant/workbench-preview/project-conversation-messages";

const turnId = "22222222-2222-4222-8222-222222222222";
const callId = "33333333-3333-4333-8333-333333333333";
const callItem = "44444444-4444-4444-8444-444444444444";
const resultItem = "55555555-5555-4555-8555-555555555555";
const childId = "66666666-6666-4666-8666-666666666666";
const operationId = "77777777-7777-4777-8777-777777777777";
const start: AgentEventPayload = {type: "turnStarted", turnId, contextSnapshotId: turnId, model: {providerId: "test", modelId: "test", revision: null}};
const finish: AgentEventPayload = {type: "turnFinished", turnId, outcome: "interrupted"};
function project(payloads: AgentEventPayload[]) {
  return applyAgentEvents(createAgentConversationProjection(id), [start, ...payloads, finish].map((payload, index) => decodeAgentEvent({
    schemaVersion: 1, conversationId: id, requestId: turnId, seq: index + 1, timestampMs: index + 1, payload,
  })));
}
function call(name: string): AgentEventPayload {
  return {type: "itemAccepted", turnId, itemId: callItem, kind: {type: "toolCall", callId, name, providerCallId: "provider-call"}, text: "{}", phase: null, source: null};
}
const child = () => project([call("research_spawn_subtask"), {type: "childCreationPrepared", turnId, callId, version: 1, childId, operationId, binding: {kind: "note", resourceId: "note"}}]);
const receipt = () => project([call("read"), {type: "toolReceiptPending", turnId, callId},
  {type: "itemStarted", turnId, itemId: resultItem, kind: {type: "toolResult", callId}}, {type: "itemCompleted", turnId, itemId: resultItem}]);

it("keeps only the matching in-turn warning, and restores the fallback if the displayed history is stale", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    for (const projection of [child(), receipt()]) {
      const render = (messages: ReturnType<typeof projectConversationMessages>) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id}
        activePath="main.tex" content="source" contentHash="hash" files={[]} messages={messages} projection={projection}
        historyReady open onOpenChange={() => undefined}/>);
      const messages = projectConversationMessages(projection);
      await act(async () => render(messages));
      expect(host.querySelector('[data-agent-message-id$="/tool-recovery-fallback"]')).toBeNull();
      expect(host.textContent).toMatch(/子任务|回执尚未确认/);
      await act(async () => render(messages.map(message => ({...message, conversationId: childId}))));
      expect(host.querySelector(`.writing-agent-turn[data-agent-turn-id="${turnId}"] [data-agent-message-id$="/tool-recovery-fallback"]`)).not.toBeNull();
      await act(async () => render(messages.map(message => message.childCreationRecovery
        ? {...message, childCreationRecovery: message.childCreationRecovery.map(identity => ({...identity, watermark: identity.watermark - 1}))}
        : message.unconfirmedToolReceiptIds ? {...message, unconfirmedToolReceiptIds: []} : message)));
      expect(host.querySelector(`.writing-agent-turn[data-agent-turn-id="${turnId}"] [data-agent-message-id$="/tool-recovery-fallback"]`)).not.toBeNull();
      await act(async () => render([]));
      expect(host.querySelector(`.writing-agent-turn[data-agent-turn-id="${turnId}"] [data-agent-message-id$="/tool-recovery-fallback"]`)).not.toBeNull();
    }
  } finally {await act(async () => root.unmount()); host.remove();}
});

it("retains the fallback for an unknown tool without a child intent or receipt", async () => {
  const projection = project([call("unknown_tool")]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id}
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={projectConversationMessages(projection)} projection={projection}
      historyReady open onOpenChange={() => undefined}/>));
    const fallback = host.querySelector(`.writing-agent-turn[data-agent-turn-id="${turnId}"] [data-agent-message-id$="/tool-recovery-fallback"]`);
    expect(fallback?.textContent).toContain("工具操作尚待核对");
    expect(fallback?.querySelector('[aria-label="复制诊断信息"]')).not.toBeNull();
  } finally {await act(async () => root.unmount()); host.remove();}
});
