/** @vitest-environment happy-dom */
import {mocks, id, WritingAgentRuntimePanel} from "./WritingAgentRuntimePanel.test-harness";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import type {AgentConversationProjection, AgentTurnProjection} from "@research-assistant/core/agent";
import type {AgentWorkspaceReviewGateway} from "@research-assistant/data/agent";
import {notify} from "../../../../../apps/web/src/core/public/feedback";

it("shows one local retriable failure for a history lookup, not one per completed turn", async () => {
  const turn = (snapshot: string): AgentTurnProjection => ({contextSnapshotId: snapshot, outcome: "completed", phase: "runningModel",
    model: {providerId: "mock", modelId: "mock", revision: null}, itemOrder: [], items: new Map(), attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null});
  const projection: AgentConversationProjection = {conversationId: id, seq: 2, activeTurn: null, turnOrder: ["a", "b"], turns: new Map([["a", turn("a")], ["b", turn("b")]])};
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  mocks.list.mockRejectedValueOnce({code: "DATA_READ_FAILURE", requestId: "request-123"});
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper" activePath="main.tex"
      content="source" contentHash="hash" files={[]} projection={projection} messages={[
        {id:"a/answer",turnId:"a",role:"assistant",content:"First",turnFinished:true},
        {id:"b/answer",turnId:"b",role:"assistant",content:"Second",turnFinished:true},
      ]} historyReady open onOpenChange={() => undefined} />));
    await vi.waitFor(() => expect(host.querySelectorAll(".writing-agent-message.assistant.failure")).toHaveLength(1));
    const failure = host.querySelector<HTMLElement>(".writing-agent-message.assistant.failure")!;
    expect(failure.closest(".writing-agent-messages")).not.toBeNull();
    expect(failure.textContent).toContain("DATA_READ_FAILURE");
    expect(failure.textContent).toContain("request-123");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(vi.mocked(notify.error).mock.calls.some(([message]) => message.includes("无法读取本轮文件变更"))).toBe(false);
    mocks.list.mockResolvedValueOnce({schemaVersion: 1, entries: [], nextCursor: null});
    await act(async () => [...failure.querySelectorAll("button")].find(button => button.textContent === "重新读取")!.click());
    await vi.waitFor(() => expect(host.querySelector(".writing-agent-message.assistant.failure")).toBeNull());
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("shows a scope-specific review failure in the same chat error presentation and retries it", async () => {
  const turn: AgentTurnProjection = {contextSnapshotId: "snapshot", outcome: "completed", phase: "runningModel",
    model: {providerId: "mock", modelId: "mock", revision: null}, itemOrder: [], items: new Map(), attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null};
  const projection: AgentConversationProjection = {conversationId: id, seq: 1, activeTurn: null, turnOrder: ["turn"], turns: new Map([["turn", turn]])};
  const scope = {conversationId: id, manuscriptId: id, requestId: "request-one", contextSnapshotId: "snapshot"};
  const gateway = mocks as unknown as AgentWorkspaceReviewGateway;
  gateway.review = vi.fn().mockRejectedValueOnce({code: "REVIEW_READ_FAILED"}).mockResolvedValueOnce({binding: {scope}, changes: []});
  mocks.list.mockResolvedValueOnce({schemaVersion: 1, entries: [{turnId: "turn", scope, createdAt: "now"}], nextCursor: null});
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper" activePath="main.tex"
      content="source" contentHash="hash" files={[]} projection={projection} messages={[
        {id:"turn/answer",turnId:"turn",role:"assistant",content:"Answer",turnFinished:true},
      ]} historyReady open onOpenChange={() => undefined} />));
    await vi.waitFor(() => expect(host.querySelector(".writing-agent-message.assistant.failure")?.textContent).toContain("REVIEW_READ_FAILED"));
    const failure = host.querySelector<HTMLElement>(".writing-agent-message.assistant.failure")!;
    expect(failure.closest(".writing-agent-messages")).not.toBeNull();
    expect(failure.textContent).toContain("request-one");
    expect(failure.closest('[data-agent-turn-id="turn"]')).not.toBeNull();
    const footer = failure.closest('[data-agent-turn-id="turn"]')?.querySelector('[data-deferred-response-footer]');
    expect(footer).not.toBeNull();
    expect(failure.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => [...failure.querySelectorAll("button")].find(button => button.textContent === "重新读取")!.click());
    await vi.waitFor(() => expect(host.querySelector(".writing-agent-message.assistant.failure")).toBeNull());
    expect(gateway.review).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
