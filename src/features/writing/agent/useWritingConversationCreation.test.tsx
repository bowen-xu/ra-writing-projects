/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import type {AgentCreateBoundProof, AgentCreateBoundRequest, AgentConversationSummary} from "@research-assistant/core/agent";
import {WritingRuntimeAdmissionScope} from "../persistence/writingRuntimeAdmission";
import {useWritingConversationCreation} from "./useWritingConversationCreation";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of closes.splice(0)) await close(); vi.unstubAllGlobals();});
const proof = (request: AgentCreateBoundRequest): AgentCreateBoundProof => ({schemaVersion: 1, operationId: request.operationId,
  conversationId: request.id, family: "agent.conversation.create_bound", epoch: request.binding.resourceId, sqlFence: "0", replayed: false, result: null});
async function fixture() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const id = crypto.randomUUID(), manuscriptId = crypto.randomUUID(); let disabled = false;
  const summary: AgentConversationSummary = {id, title: "Synthetic", archived: false, durableCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01"};
  const creation = {createBound: vi.fn(async (request: AgentCreateBoundRequest) => proof(request)),
    createBoundStatus: vi.fn(async (request: AgentCreateBoundRequest) => ({schemaVersion: 1, operationId: request.operationId, conversationId: request.id, status: {type: "committed", proof: proof(request)}}))};
  const metadata = {read: vi.fn(async () => summary)}, drafts = {adoptPending: vi.fn()}, created = vi.fn();
  const props = {conversationId: id, manuscriptId, drafts, gateways: {creation, metadata}, onConversationCreated: created} as unknown as Parameters<typeof useWritingConversationCreation>[0];
  const lifecycle = {current: 0}, root = createRoot(document.createElement("div"));
  const admission = {isDisabled: () => disabled, subscribe: () => () => undefined};
  let current!: ReturnType<typeof useWritingConversationCreation>;
  function Host() {current = useWritingConversationCreation(props, true, lifecycle); return null;}
  await act(async () => root.render(<WritingRuntimeAdmissionScope value={admission}><Host /></WritingRuntimeAdmissionScope>));
  closes.push(async () => {await act(async () => root.unmount());});
  return {id, summary, creation, metadata, drafts, created, get: () => current, disable: () => {disabled = true;}};
}
it("does not start a new bound conversation after a synchronous lifecycle disable", async () => {
  const f = await fixture(); f.disable();
  await act(async () => expect(await f.get().ensureConversation()).toBe(false));
  expect(f.creation.createBound).not.toHaveBeenCalled(); expect(f.metadata.read).not.toHaveBeenCalled();
});
it("adopts the original create acknowledgement after disable without starting another creation", async () => {
  const f = await fixture(); let finish!: (value: AgentCreateBoundProof) => void;
  f.creation.createBound.mockImplementationOnce(() => new Promise<AgentCreateBoundProof>(resolve => {finish = resolve;}));
  let work!: Promise<boolean>; await act(async () => {work = f.get().ensureConversation();});
  expect(f.creation.createBound).toHaveBeenCalledOnce(); f.disable();
  await act(async () => {finish(proof(f.creation.createBound.mock.calls[0]![0])); expect(await work).toBe(true);});
  expect(f.drafts.adoptPending).toHaveBeenCalledOnce(); expect(f.created).toHaveBeenCalledWith(f.summary);
});
it("retains original creation status and read recovery while the instance cannot admit new work", async () => {
  const f = await fixture(); f.creation.createBound.mockRejectedValueOnce(new Error("lost ACK"));
  await act(async () => expect(await f.get().ensureConversation()).toBe(false)); f.disable();
  await act(async () => {await f.get().creation.check();});
  let summary: AgentConversationSummary | null = null;
  await act(async () => {summary = await f.get().creation.readCurrent();});
  await act(async () => {f.get().captureAdoption()(summary);});
  expect(f.creation.createBound).toHaveBeenCalledOnce(); expect(f.creation.createBoundStatus).toHaveBeenCalledOnce();
  expect(f.metadata.read).toHaveBeenCalledOnce(); expect(f.created).toHaveBeenCalledWith(f.summary);
});
