/** @vitest-environment happy-dom */
import { mocks, id, buttonByText, WritingAgentRuntimePanel } from "./WritingAgentRuntimePanel.test-harness";
import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentConversationSummary } from "@research-assistant/core/agent";
import { getAppStorage } from "../../../../../apps/web/src/core/runtime/appStorage";
import { resetConversationCreationOwnersForTests } from "../../../../../apps/web/src/core/features/agent/conversationCreationController";
import { readBoundCreation } from "../../../../../apps/web/src/core/features/agent/boundConversationCreationPending";
import { parseManuscriptPath } from "@research-assistant/writing";
import { useWritingAgentHistory } from "./useWritingAgentHistory";
import { WritingDiffDemoHistory } from "../../../../../apps/web/src/app/previews/agent/WritingDiffDemoHistory";
import { clearAgentSessionSelection, readAgentSessionSelection, writeAgentSessionSelection } from "../../../../../apps/web/src/core/features/agent/agentSessionSelection";

let host: HTMLDivElement, root: Root;
const created = vi.fn(), ended = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mocks.prepareWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: request.conversationId,
    requestId: request.requestId, manuscriptId: id, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, context: [] } }));
  mocks.startWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: request.conversationId,
    requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetConversationCreationOwnersForTests(getAppStorage()); });
function Probe({ conversationId = id, manuscriptId = id }: { conversationId?: string; manuscriptId?: string }) {
  const [pending, setPending] = useState(true);
  return <WritingAgentRuntimePanel manuscriptId={manuscriptId} conversationId={conversationId} pendingConversationId={pending ? conversationId : null}
    onConversationCreated={current => { created(current); setPending(false); }} onConversationCreationFinished={ended}
    conversationTitle="新对话" activePath="main.tex" content="source" contentHash="hash"
    files={[{ manuscriptId, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
    readEditorSnapshot={() => ({documentKey: `${manuscriptId}:main.tex`, sessionId: id, revision: id, text: "source"})}
    messages={[]} projection={null} historyReady open onOpenChange={() => {}} />;
}
async function render() { await act(async () => root.render(<Probe />)); }
async function send(text = "Keep this draft") {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function click(label: string) { await act(async () => buttonByText(label)!.click()); }

it("waits for the new conversation handoff read before resuming its first send", async () => {
  let finish!: (page: {schemaVersion: 1; conversationId: string; epoch: string; items: []}) => void;
  mocks.handoffRead.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  await render(); await send("First question");
  await vi.waitFor(() => expect(mocks.handoffRead).toHaveBeenCalled());
  expect(mocks.prepareWriting).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")?.value).toBe("First question");
  await act(async () => finish({schemaVersion: 1, conversationId: id, epoch: "99999999-9999-4999-8999-999999999999", items: []}));
  await vi.waitFor(() => expect(mocks.prepareWriting).toHaveBeenCalledOnce());
});

it("locks a lost creation ACK and checks status without metadata or model work before explicit read", async () => {
  mocks.createBound.mockRejectedValueOnce(new Error("reply lost"));
  await render(); await send(); const intent = mocks.createBound.mock.calls[0]![0];
  expect(intent).toMatchObject({ id, binding: { kind: "manuscript", resourceId: id } }); expect(intent.operationId).not.toBe(id);
  await send("Keep this draft"); expect(mocks.createBound).toHaveBeenCalledTimes(1);
  expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
  await click("核对原创建操作");
  expect(mocks.createBoundStatus).toHaveBeenCalledExactlyOnceWith(intent); expect(mocks.metadataRead).not.toHaveBeenCalled();
  await click("读取当前对话");
  expect(mocks.metadataRead).toHaveBeenCalledExactlyOnceWith({ id, binding: intent.binding }); expect(created).toHaveBeenCalledOnce();
  expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled();
  expect(readBoundCreation(intent.binding)).toBeNull();
  await send(); expect(mocks.prepareWriting).toHaveBeenCalledOnce(); expect(mocks.createBound).toHaveBeenCalledTimes(1);
});

it("keeps a committed creation after metadata failure and retries only the current read", async () => {
  mocks.metadataRead.mockRejectedValueOnce({ code: "METADATA_READ_UNAVAILABLE", status: 503 });
  await render(); await send();
  expect(host.textContent).toContain("METADATA_READ_UNAVAILABLE"); expect(host.textContent).toContain("HTTP 503");
  expect(mocks.createBound).toHaveBeenCalledTimes(1); expect(created).not.toHaveBeenCalled();
  await click("读取当前对话");
  expect(mocks.createBound).toHaveBeenCalledTimes(1); expect(mocks.metadataRead).toHaveBeenCalledTimes(2);
  expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(created).toHaveBeenCalledOnce();
});

it("does not adopt or prepare from a delayed read after the manuscript scope is replaced", async () => {
  let finish!: (value: AgentConversationSummary) => void;
  mocks.metadataRead.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); await send(); const intent = mocks.createBound.mock.calls[0]![0];
  await act(async () => root.render(<Probe key="another" manuscriptId="22222222-2222-4222-8222-222222222222" />));
  await act(async () => finish({ id, title: "Original", archived: false, durableCount: 0, createdAt: "now", updatedAt: "now" }));
  expect(created).not.toHaveBeenCalled(); expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled();
  expect(readBoundCreation(intent.binding)?.intent).toEqual(intent);
});

it("does not let an explicit recovery read adopt after its requesting view detaches", async () => {
  mocks.createBound.mockRejectedValueOnce(new Error("lost reply")); await render(); await send(); await click("核对原创建操作");
  const intent=mocks.createBound.mock.calls[0]![0]; let finish!:(value:AgentConversationSummary)=>void;
  mocks.metadataRead.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await click("读取当前对话"); await act(async()=>root.render(<Probe key="new-view" manuscriptId="22222222-2222-4222-8222-222222222222"/>));
  await act(async()=>finish({id,title:"Original",archived:false,durableCount:0,createdAt:"now",updatedAt:"now"}));
  expect(created).not.toHaveBeenCalled();expect(mocks.prepareWriting).not.toHaveBeenCalled();expect(mocks.startWriting).not.toHaveBeenCalled();
  expect(readBoundCreation(intent.binding)?.intent).toEqual(intent);
});

it("rejects host adoption when another window replaced the locator during metadata read",async()=>{
  let finish!:(value:AgentConversationSummary)=>void;mocks.metadataRead.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await render();await send();const storage=getAppStorage(),locator=[...Array(storage.length)].map((_,i)=>storage.key(i)!).find(key=>key.startsWith("research-assistant:bound-conversation-creation:"))!;
  const row=JSON.parse(storage.getItem(locator)!),foreign=JSON.stringify({...row,intent:{...row.intent,operationId:crypto.randomUUID(),id:crypto.randomUUID()}});
  storage.setItem(locator,foreign);await act(async()=>finish({id,title:"Original",archived:false,durableCount:0,createdAt:"now",updatedAt:"now"}));
  expect(created).not.toHaveBeenCalled();expect(mocks.prepareWriting).not.toHaveBeenCalled();expect(storage.getItem(locator)).toBe(foreign);
});

it("blocks cached submission into a pending view when its original C already adopted but cleanup failed",async()=>{
  mocks.createBound.mockRejectedValueOnce(new Error("lost reply"));await render();await send();await click("核对原创建操作");
  const storage=getAppStorage(),remove=storage.removeItem.bind(storage);
  storage.removeItem=key=>{if(key.startsWith("research-assistant:bound-conversation-creation:"))throw new Error("quota");remove(key);};
  try {
    await click("读取当前对话");expect(created).toHaveBeenCalledOnce();expect(mocks.prepareWriting).not.toHaveBeenCalled();
    await act(async()=>root.render(<Probe key="new-local-view"/>));await send();
    expect(created).toHaveBeenCalledTimes(1);expect(mocks.prepareWriting).not.toHaveBeenCalled();
    expect(mocks.createBound).toHaveBeenCalledTimes(1);
  } finally {storage.removeItem=remove;}
});

it("ends adopted recovery in a remounted pending host by reserving a genuinely new local C and operation",async()=>{
  const backend=new WritingDiffDemoHistory();let selected!:ReturnType<typeof useWritingAgentHistory>;
  function Combined() {
    const access=useMemo(()=>({identity:"creation-history",gateway:backend.gateway,metadata:{read:mocks.metadataRead},selection:{read:readAgentSessionSelection,write:writeAgentSessionSelection,clear:clearAgentSessionSelection}}),[]);
    const history=useWritingAgentHistory(id,access);selected=history;
    return <><button onClick={history.newConversation}>新建本地会话</button><WritingAgentRuntimePanel manuscriptId={id} conversationId={history.selectedId}
      pendingConversationId={history.pendingConversationId} onConversationCreated={history.conversationCreated} onConversationCreationFinished={history.newConversation}
      conversationTitle="新对话" activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={history.conversation.projection}
      historyReady open onOpenChange={()=>{}}/></>;
  }
  const storage=getAppStorage(),set=storage.setItem.bind(storage),remove=storage.removeItem.bind(storage);
  storage.setItem=(key,value)=>{if(key.startsWith("research-assistant.agent-session."))throw new Error("selection unavailable");set(key,value);};
  storage.removeItem=key=>{if(key.startsWith("research-assistant:bound-conversation-creation:"))throw new Error("cleanup unavailable");remove(key);};
  try {
    mocks.createBound.mockRejectedValueOnce(new Error("lost reply"));await act(async()=>root.render(<Combined/>));await click("新建本地会话");await send();
    const original=mocks.createBound.mock.calls[0]![0];await click("核对原创建操作");await click("读取当前对话");
    expect(selected.pendingConversationId).toBeNull();expect(mocks.prepareWriting).not.toHaveBeenCalled();
    await act(async()=>root.unmount());root=createRoot(host);await act(async()=>root.render(<Combined/>));
    expect(selected.pendingConversationId).toBe(original.id);await send();expect(mocks.createBound).toHaveBeenCalledTimes(1);expect(mocks.prepareWriting).not.toHaveBeenCalled();
    storage.removeItem=remove;await click("清理本机记录并结束恢复");
    const fresh=readBoundCreation(original.binding)!;
    expect(selected.pendingConversationId).not.toBe(original.id);expect(selected.pendingConversationId).toBe(fresh.intent.id);
    expect(fresh.intent.operationId).not.toBe(original.operationId);expect(mocks.createBound).toHaveBeenCalledTimes(1);
    expect(mocks.prepareWriting).not.toHaveBeenCalled();expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally {storage.setItem=set;storage.removeItem=remove;backend.dispose();}
});

it.each(["archived", "notFound"])("keeps the draft and explicitly ends known creation recovery after %s", async boundary => {
  if (boundary === "archived") mocks.metadataRead.mockImplementationOnce(async request => ({ id: request.id, title: "Old", archived: true, durableCount: 0, createdAt: "now", updatedAt: "now" }));
  else mocks.metadataRead.mockRejectedValueOnce("notFound");
  await render(); await send(); const intent = mocks.createBound.mock.calls[0]![0];
  expect(created).not.toHaveBeenCalled(); expect(mocks.prepareWriting).not.toHaveBeenCalled();
  await click("保留草稿并结束本次创建核对");
  expect(ended).toHaveBeenCalledOnce(); expect(readBoundCreation(intent.binding)).toBeNull();
  expect(host.querySelector("textarea")?.value).toBe("Keep this draft"); expect(mocks.startWriting).not.toHaveBeenCalled();
});
