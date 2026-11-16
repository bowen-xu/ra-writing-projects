/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWritingAgentHistory } from "@research-assistant/writing-projects-preview/use-writing-agent-history";
import { getAppStorage, selectAppStorage } from "@research-assistant/workbench-preview/app-storage";
import { pendingBoundConversationId, readBoundCreation } from "@research-assistant/workbench-preview/bound-conversation-creation-pending";

vi.mock("@research-assistant/workbench-preview/use-agent-conversation", () => ({ useAgentConversation: vi.fn(() => ({ status: "ready", projection: null })) }));
vi.mock("@research-assistant/workbench-preview/use-conversation-metadata", () => ({ useConversationMetadata: vi.fn(() => ({ status: "ready", conversation: null, refresh: vi.fn() })) }));
vi.mock("@research-assistant/workbench-preview/notifications", () => ({ notify: {error: vi.fn()} }));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const manuscriptId = "67c6f3d2-1190-4b65-b28b-c80552e852e1";
const binding = {kind: "manuscript" as const, resourceId: manuscriptId};
let root: ReturnType<typeof createRoot>, state: ReturnType<typeof useWritingAgentHistory>;
function Probe() { state = useWritingAgentHistory(manuscriptId); return null; }
beforeEach(() => {
  const values = new Map<string,string>(); selectAppStorage({get length(){return values.size;}, key:n=>[...values.keys()][n]??null,
    getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);},removeItem:k=>{values.delete(k);},clear:()=>values.clear()});
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {await act(async()=>root.unmount());});
it("restores the same pending C and creation intent after the history host remounts",async()=>{
  await act(async()=>root.render(<Probe/>));await act(async()=>state.newConversation());
  const id=state.pendingConversationId, saved=readBoundCreation(binding);expect(id).not.toBeNull();expect(saved?.intent.operationId).not.toBe(id);
  await act(async()=>root.unmount());root=createRoot(document.createElement("div"));await act(async()=>root.render(<Probe/>));
  expect(state.pendingConversationId).toBe(id);expect(state.selectedId).toBe(id);
  await act(async()=>state.newConversation());expect(state.pendingConversationId).toBe(id);expect(readBoundCreation(binding)).toEqual(saved);
});
it("does not replace an explicitly selected durable conversation with an older pending locator",async()=>{
  await act(async()=>root.render(<Probe/>));await act(async()=>state.newConversation());const pending=state.pendingConversationId;
  const durable=crypto.randomUUID();await act(async()=>state.select(durable));
  await act(async()=>root.unmount());root=createRoot(document.createElement("div"));await act(async()=>root.render(<Probe/>));
  expect(state.selectedId).toBe(durable);expect(state.pendingConversationId).toBeNull();expect(pendingBoundConversationId(binding)).toBe(pending);
});
it("preserves corrupt pending bytes and current selection when local creation reservation cannot be trusted",async()=>{
  await act(async()=>root.render(<Probe/>));await act(async()=>state.newConversation());
  const storage=getAppStorage(), locator=[...Array(storage.length)].map((_,i)=>storage.key(i)!).find(key=>key.startsWith("research-assistant:bound-conversation-creation:"))!;
  storage.setItem(locator,"{corrupt");const selected=state.selectedId;await act(async()=>state.newConversation());
  expect(state.selectedId).toBe(selected);expect(storage.getItem(locator)).toBe("{corrupt");
});
it("does not turn an adopted durable C with an uncleared locator back into a new pending draft",async()=>{
  await act(async()=>root.render(<Probe/>));await act(async()=>state.newConversation());const id=state.pendingConversationId!,saved=readBoundCreation(binding);
  await act(async()=>state.conversationCreated({id,title:"Created",archived:false,durableCount:12,createdAt:"now",updatedAt:"now"}));
  expect(state.pendingConversationId).toBeNull();await act(async()=>state.newConversation());
  expect(state.selectedId).toBe(id);expect(state.pendingConversationId).toBeNull();expect(readBoundCreation(binding)).toEqual(saved);
});
