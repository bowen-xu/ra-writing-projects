/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {AgentWritingSteerRequest} from "@research-assistant/core/agent";
import {AgentSteeringRegistry} from "@research-assistant/data/agent";
import { useWritingSteering } from "./useWritingSteering";
import {WritingRuntimeAdmissionScope} from "../persistence/writingRuntimeAdmission";
const mocks = vi.hoisted(() => ({ steerWriting: vi.fn() }));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  agentSteeringGateway: mocks,
}));
const scope = { conversationId: "conversation", manuscriptId: "manuscript", turnId: "turn" };
async function harness() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const accepted = vi.fn();
  let current: ReturnType<typeof useWritingSteering>;
  function Test({ turn }: { turn: string }) { current = useWritingSteering({ ...scope, turnId: turn }, accepted); return null; }
  await act(async () => root.render(<Test turn="turn" />));
  return { accepted, get: () => current!, switch: async () => { await act(async () => root.render(<Test turn="other" />)); }, close: async () => { await act(async () => root.unmount()); } };
}
it("keeps the idempotency key after an uncertain failure", async () => {
  mocks.steerWriting.mockReset().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce({});
  const h = await harness();
  try {
    await act(async () => h.get().submit("text"));
    expect(h.accepted).not.toHaveBeenCalled();
    expect(h.get().status).toContain("未确认");
    await act(async () => h.get().submit("text"));
    expect(mocks.steerWriting.mock.calls[0]?.[0].inputId).toBe(mocks.steerWriting.mock.calls[1]?.[0].inputId);
    expect(h.accepted).toHaveBeenCalledWith("text");
  } finally { await h.close(); }
});
it("prevents duplicate submission and ignores late acceptance after switching turns", async () => {
  let finish!: () => void;
  mocks.steerWriting.mockReset().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const h = await harness();
  try {
    let pending!: Promise<boolean>;
    await act(async () => { pending = h.get().submit("text"); });
    await act(async () => h.get().submit("text"));
    expect(mocks.steerWriting).toHaveBeenCalledTimes(1);
    await h.switch();
    await act(async () => { finish(); await pending; });
    expect(h.accepted).not.toHaveBeenCalled();
    expect(h.get().status).toBe("");
  } finally { await h.close(); }
});
it("reports a closed turn without clearing text or starting another request", async () => {
  mocks.steerWriting.mockReset().mockRejectedValue({ code: "closed" });
  const h = await harness();
  try {
    await act(async () => h.get().submit("text"));
    expect(h.accepted).not.toHaveBeenCalled();
    expect(h.get().status).toContain("已停止接收");
    expect(mocks.steerWriting).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
});
it("holds unknown input through draft and turn changes, with explicit old-receipt retry",async()=>{
  mocks.steerWriting.mockReset().mockRejectedValueOnce(new Error("lost")).mockRejectedValueOnce({code:"closed"}).mockResolvedValueOnce({});
  const h=await harness();
  try{
    await act(async()=>h.get().submit("original"));await act(async()=>h.get().submit("new draft"));
    expect(mocks.steerWriting).toHaveBeenCalledOnce();await h.switch();
    expect(h.get().uncertain).toBe(true);await act(async()=>h.get().retry());expect(h.get().uncertain).toBe(true);
    await act(async()=>h.get().retry());expect(h.accepted).not.toHaveBeenCalled();
    expect(mocks.steerWriting.mock.calls[0]).toEqual(mocks.steerWriting.mock.calls[2]);
  }finally{await h.close();}
});

it("passes the original writing runtime predicate through the production hook to the owned steer",async()=>{
  let disabled=false,release!:()=>void;
  const send=vi.fn(async(request:AgentWritingSteerRequest)=>({schemaVersion:1 as const,conversationId:request.conversationId,turnId:request.turnId,inputId:request.inputId})),accepted=vi.fn();
  const registry=new AgentSteeringRegistry<typeof scope>(send,()=>"original",()=>()=>new Promise<void>(resolve=>{release=resolve;}));
  const admission={isDisabled:()=>disabled,subscribe:()=>()=>undefined};
  const host={key:"host",conversationId:scope.conversationId,captureAcknowledgment:()=>accepted};
  const access={send,registry};let current!:ReturnType<typeof useWritingSteering>;
  function Test(){current=useWritingSteering(scope,accepted,null,host,access);return null;}
  const root=createRoot(document.createElement("div"));
  try{
    await act(async()=>root.render(<WritingRuntimeAdmissionScope value={admission}><Test/></WritingRuntimeAdmissionScope>));
    let work!:Promise<boolean>;await act(async()=>{work=current.submit("keep");});
    expect(release).toBeTypeOf("function");disabled=true;
    await act(async()=>{release();expect(await work).toBe(false);});
    expect(send).not.toHaveBeenCalled();expect(accepted).not.toHaveBeenCalled();
    expect(current.state.phase).toBe("rejected");expect(current.status).toMatch(/^WRITING_RUNTIME_UNAVAILABLE：/u);
  }finally{await act(async()=>root.unmount());registry.dispose();}
});
