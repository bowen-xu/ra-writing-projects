// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { decodeAgentEvent } from "@research-assistant/core/agent";
import type { AgentSessionGateway } from "@research-assistant/data/agent";
import raw from "../../fixtures/agent-events-v1.json";
import { useWritingAgentHistory, type WritingAgentHistoryAccess } from "@research-assistant/writing-projects-preview/use-writing-agent-history";

vi.mock("@research-assistant/workbench-preview/use-conversation-metadata", () => ({useConversationMetadata: () => ({status:"ready", conversation:null, refresh:async()=>undefined})}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;

it("suspends hidden history and catches up events on the saved cursor when shown again", async () => {
  const id = "00000000-0000-0000-0000-000000000001", events = raw.map(decodeAgentEvent);
  let watermark = 3;
  const signals: AbortSignal[] = [];
  const gateway: AgentSessionGateway = {
    create: vi.fn(), open: vi.fn<AgentSessionGateway["open"]>(async () => ({schemaVersion:1, conversationId:id, watermark})),
    readHistory: vi.fn<AgentSessionGateway["readHistory"]>(async request => ({schemaVersion:1, conversationId:id, afterSeq:request.afterSeq, watermark,
      nextAfterSeq:null, events:events.slice(request.afterSeq,watermark)})),
    waitForHistory: vi.fn<AgentSessionGateway["waitForHistory"]>((_request, signal) => new Promise((_resolve,reject) => {
      if (signal) {signals.push(signal);signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});}
    })),
  };
  const access = {identity:crypto.randomUUID(), gateway, metadata:{} as WritingAgentHistoryAccess["metadata"],
    selection:{read:()=>id,write:()=>undefined,clear:()=>undefined}} satisfies WritingAgentHistoryAccess;
  let snapshot!: ReturnType<typeof useWritingAgentHistory>;
  function Probe({visible}:{visible:boolean}) {snapshot=useWritingAgentHistory("manuscript",access,visible);return null;}
  const root=createRoot(document.createElement("div"));
  try {
    await act(async()=>root.render(<Probe visible/>));
    await vi.waitFor(()=>expect(snapshot.conversation).toMatchObject({status:"ready",projection:{seq:3}}));
    expect(signals).toHaveLength(1);
    await act(async()=>root.render(<Probe visible={false}/>));
    expect(signals[0]?.aborted).toBe(true);
    watermark=6;
    await act(async()=>root.render(<Probe visible/>));
    await vi.waitFor(()=>expect(snapshot.conversation).toMatchObject({status:"ready",projection:{seq:6}}));
    expect(gateway.readHistory).toHaveBeenLastCalledWith(expect.objectContaining({afterSeq:3}));
  } finally {await act(async()=>root.unmount());}
});
