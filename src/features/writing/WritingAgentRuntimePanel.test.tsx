/** @vitest-environment happy-dom */
import { mocks, id, submissionContext, WritingAgentRuntimePanel } from "./WritingAgentRuntimePanel.test-harness";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { WritingAgentPanel } from "../../../../../apps/web/src/core/features/agent/presentation/WritingAgentPanel";
import { agentMetadataGateway } from "../../../../../apps/web/src/core/services/agentGateway";
import { renameProof } from "../../../../../apps/web/src/core/features/agent/conversationRenameTestFacts";
import { notify } from "../../../../../apps/web/src/core/public/feedback";
import { applyAgentEvents, createAgentConversationProjection, decodeAgentEvent, EMPTY_AGENT_CONTEXT } from "@research-assistant/core/agent";
import { WritingSubmissionController } from "../../../../../apps/web/src/core/features/agent/writingSubmissionController";
import { AgentSteeringController } from "@research-assistant/data/agent";
import * as appRuntime from "../../../../../apps/web/src/core/runtime/appRuntime";
import { getAppStorage } from "../../../../../apps/web/src/core/runtime/appStorage";
import { registerStoragePersistence } from "../../../../../apps/web/src/core/runtime/storagePersistence";
import { NATIVE_PREVIEW_OWNER_CAPABILITY, readPreviewOwnerIntent } from "../../../../../apps/web/src/core/runtime/nativePreviewOwnerIntent";

it("waits for context hydration before preparing a manually submitted turn", async () => {
  vi.clearAllMocks();
  let release!: (value: {revision: number; state: typeof EMPTY_AGENT_CONTEXT}) => void;
  mocks.contextRead.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  mocks.read.mockResolvedValue({ schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: [] });
  mocks.prepareWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id, manuscriptId: id,
    requestId: request.requestId, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})}
      files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined}/>));
    const input = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Wait for context"); input.dispatchEvent(new Event("input",{bubbles:true})); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    expect(input.value).toBe("Wait for context");
    await act(async () => { release({revision: 0, state: EMPTY_AGENT_CONTEXT}); });
    await vi.waitFor(() => expect(mocks.startWriting).toHaveBeenCalledOnce());
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not dispatch a canceled send when delayed context hydration completes", async () => {
  vi.clearAllMocks();
  let release!: (value: {revision: number; state: typeof EMPTY_AGENT_CONTEXT}) => void;
  mocks.contextRead.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  mocks.read.mockResolvedValue({ schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: [] });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={null}
      historyReady open onOpenChange={() => undefined}/>));
    const input = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Cancel waiting"); input.dispatchEvent(new Event("input",{bubbles:true})); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(container.textContent).toContain("正在核对对话状态");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    await act(async () => { release({revision: 0, state: EMPTY_AGENT_CONTEXT}); });
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    expect(mocks.startWriting).not.toHaveBeenCalled();
    expect(input.value).toBe("Cancel waiting");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("retains the draft without replaying a send after context hydration fails and later recovers", async () => {
  vi.clearAllMocks();
  let fail!: (reason: Error) => void;
  mocks.contextRead.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockResolvedValue({revision: 0, state: EMPTY_AGENT_CONTEXT});
  mocks.read.mockResolvedValue({ schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: [] });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (loading: boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={null}
    historyReady metadataLoading={loading} open onOpenChange={() => undefined}/>);
  try {
    await act(async () => render(false));
    const input = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Keep after failure"); input.dispatchEvent(new Event("input",{bubbles:true})); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await act(async () => { fail(new Error("synthetic context read failure")); });
    expect(input.value).toBe("Keep after failure");
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    await act(async () => render(true));
    await act(async () => render(false));
    expect(mocks.contextRead.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    expect(mocks.startWriting).not.toHaveBeenCalled();
    expect(input.value).toBe("Keep after failure");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not report context recovery failure while a normal save is in flight", async () => {
  vi.clearAllMocks();
  mocks.contextRead.mockResolvedValue({revision: 0, state: EMPTY_AGENT_CONTEXT});
  const originalSave = mocks.contextSave.getMockImplementation()!;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  mocks.contextSave.mockImplementation(async (...args) => { await blocked; return originalSave(...args); });
  mocks.read.mockResolvedValue({ schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: [] });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})}
      files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined}/>));
    const input = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Save context"); input.dispatchEvent(new Event("input",{bubbles:true})); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await vi.waitFor(() => expect(mocks.contextSave).toHaveBeenCalledOnce());
    expect(notify.error).not.toHaveBeenCalledWith(expect.stringContaining("无法恢复对话上下文"));
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
  } finally { await act(async () => { release(); root.unmount(); }); container.remove(); }
});

it("consumes a retained submission outcome only after history is synchronized", async () => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: [] });
  mocks.prepareWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id, manuscriptId: id,
    requestId: request.requestId, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  const observe = vi.spyOn(WritingSubmissionController.prototype, "observeOutcome");
  const observeSteering = vi.spyOn(AgentSteeringController.prototype, "observeHistory");
  const payloads = [{type:"turnStarted",turnId:id,contextSnapshotId:id,model:{providerId:"deepseek",modelId:"deepseek-v4-pro",revision:null}},
    {type:"turnFinished",turnId:id,outcome:"completed"}];
  const projection = applyAgentEvents(createAgentConversationProjection(id), payloads.map((payload,index) => decodeAgentEvent({schemaVersion:1,conversationId:id,seq:index+1,timestampMs:1,requestId:id,payload})));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (ready: boolean, showHistory: boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})}
    files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
    messages={[]} projection={showHistory ? projection : null} historyReady={ready} open onOpenChange={() => undefined}/>);
  try {
    await act(async () => render(true, false));
    const input = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Question"); input.dispatchEvent(new Event("input",{bubbles:true})); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await vi.waitFor(() => expect(mocks.startWriting).toHaveBeenCalledOnce());
    observeSteering.mockClear();
    await act(async () => render(false, true));
    expect(observe).not.toHaveBeenCalled();
    expect(observeSteering).not.toHaveBeenCalled();
    await act(async () => render(true, true));
    expect(observe).toHaveBeenCalledWith(id,"completed");
    expect(observeSteering).toHaveBeenCalledWith(projection);
  } finally { observe.mockRestore(); observeSteering.mockRestore(); await act(async () => root.unmount()); container.remove(); }
});

it("retains the draft and does not prepare queued or manual work behind a tool recovery barrier", async () => {
  vi.clearAllMocks();
  const turnId="22222222-2222-4222-8222-222222222222",callId="33333333-3333-4333-8333-333333333333",itemId="44444444-4444-4444-8444-444444444444";
  const payloads=[
    {type:"turnStarted",turnId,contextSnapshotId:itemId,model:{providerId:"test",modelId:"test",revision:null}},
    {type:"itemAccepted",turnId,itemId,kind:{type:"toolCall",callId,name:"read"},text:"{}",phase:null,source:null},
    {type:"toolReceiptPending",turnId,callId}, {type:"turnFinished",turnId,outcome:"interrupted"},
  ];
  const projection=applyAgentEvents(createAgentConversationProjection(id),payloads.map((payload,index)=>decodeAgentEvent({schemaVersion:1,conversationId:id,seq:index+1,timestampMs:1,requestId:turnId,payload})));
  mocks.read.mockResolvedValue({schemaVersion:1,conversationId:id,manuscriptId:id,revision:1,paused:false,preparingInputId:null,
    inputs:[{inputId:"55555555-5555-4555-8555-555555555555",text:"queued draft",paused:false}]});
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {
    await act(async()=>root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper" activePath="main.tex"
      content="source" contentHash="hash" files={[]} messages={[]} projection={projection} historyReady open onOpenChange={()=>undefined}/>));
    await vi.waitFor(()=>expect(mocks.read).toHaveBeenCalled());
    const textarea=container.querySelector("textarea")!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"保留后续草稿");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    expect(textarea.value).toBe("保留后续草稿");expect(container.textContent).toContain("工具操作尚待核对");
    await act(async()=>container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(textarea.value).toBe("保留后续草稿");expect(mocks.prepareWriting).not.toHaveBeenCalled();expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());container.remove();}
});

it("opens an archived conversation with no context row without trying to initialize or save it",async()=>{
  vi.clearAllMocks();
  mocks.contextRead.mockResolvedValue(null);
  mocks.contextSave.mockRejectedValue("conversationUnavailable");
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {
    await act(async()=>root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Archived"
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={null} historyReady open archived
      onOpenChange={()=>undefined}/>));
    expect(mocks.contextRead).toHaveBeenCalledWith(id,false);
    expect(mocks.contextRead.mock.calls.every(([,initialize])=>initialize===false)).toBe(true);
    expect(mocks.contextSave).not.toHaveBeenCalled();expect(notify.error).not.toHaveBeenCalled();
    expect(container.textContent).toContain("此对话已归档");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  } finally {await act(async()=>root.unmount());container.remove();}
});

it("does not import context before the original metadata confirms a conversation is writable",async()=>{
  vi.clearAllMocks();mocks.contextRead.mockResolvedValue(null);
  mocks.contextSave.mockImplementation(async(_id:string,_revision:number,state:unknown)=>({revision:1,state}));
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  const render=(loading:boolean,archived:boolean)=>root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id}
    conversationTitle="Loading" activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]}
    projection={null} historyReady={!loading} metadataLoading={loading} open archived={archived} onOpenChange={()=>undefined}/>);
  try {
    await act(async()=>render(true,false));expect(mocks.contextSave).not.toHaveBeenCalled();
    await act(async()=>render(false,true));expect(mocks.contextSave).not.toHaveBeenCalled();
    expect(mocks.contextRead.mock.calls.every(([,initialize])=>initialize===false)).toBe(true);
    await act(async()=>render(false,false));expect(mocks.contextSave).toHaveBeenCalledTimes(1);
  } finally {await act(async()=>root.unmount());container.remove();}
});

it("keeps a pending conversation free of durable lineage and queue readers", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  mocks.metadataRead.mockResolvedValue({ id, title: "新对话", archived: false, durableCount: 0, createdAt: "now", updatedAt: "now" });
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} pendingConversationId={id}
      conversationTitle="Paper" activePath="main.tex" content="source" contentHash="hash" files={[]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} onOpenConversation={() => undefined} />));
    expect(mocks.readOrigin).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.childList).not.toHaveBeenCalled();
    expect(container.querySelector(".writing-agent-header-subtitle")?.textContent).toBe("新对话");
    expect(container.textContent).not.toContain("无法读取分支来源");
    expect(container.textContent).not.toContain("队列消息");
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "First question");
    await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.createBound).toHaveBeenCalledWith({ operationId: expect.any(String), id, binding: { kind: "manuscript", resourceId: id } });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("freezes the submission owner before a pending conversation creation can overlap a scenario change", async () => {
  vi.clearAllMocks();
  const storage = getAppStorage();
  registerStoragePersistence(storage, {backend:"IndexedDB", pending:false, error:undefined, resetting:false,
    flush:async()=>{}, retry:async()=>{}, reset:async()=>{}, subscribe:()=>()=>{}, close:()=>{}});
  const fixture = "33333333-3333-4333-8333-333333333333";
  let currentFixture: string | null = fixture;
  const preview = {bootstrap:{generation:"generation-a", supported:[NATIVE_PREVIEW_OWNER_CAPABILITY]},
    snapshotConversationOwner:()=>({generation:"generation-a", fixtureId:currentFixture})} as unknown as NonNullable<appRuntime.AppRuntime["nativeAgentPreview"]>;
  const originalRuntime = appRuntime.getAppRuntime();
  const runtimeSpy = vi.spyOn(appRuntime, "getAppRuntime").mockReturnValue({...originalRuntime, storage, nativeAgentPreview:preview});
  let finish!: (value: ReturnType<typeof import("../../../../../apps/web/src/core/features/agent/conversationCreationTestFacts").creationProof>) => void;
  let createdRequest: Parameters<typeof import("../../../../../apps/web/src/core/features/agent/conversationCreationTestFacts").creationProof>[0] | undefined;
  mocks.createBound.mockImplementation(request => {createdRequest = request; return new Promise(resolve => {finish = resolve;});});
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} pendingConversationId={id}
      conversationTitle="Paper" activePath="main.tex" content="source" contentHash="hash" files={[]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} onOpenConversation={() => undefined}/>));
    const input = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Pending question"); input.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await vi.waitFor(() => expect(mocks.createBound).toHaveBeenCalledOnce());
    const key = Array.from({length:storage.length}, (_, index)=>storage.key(index)).find(value=>value?.startsWith("research-assistant:preview-owner-intent:v1:"));
    expect(key).toBeDefined();
    const intent = JSON.parse(storage.getItem(key!)!) as {requestId:string};
    currentFixture = null;
    expect(readPreviewOwnerIntent(storage,id,intent.requestId)).toEqual({fixtureId:fixture});
    await act(async () => {root.unmount();});
    if (createdRequest) {
      const {creationProof} = await import("../../../../../apps/web/src/core/features/agent/conversationCreationTestFacts");
      finish(creationProof(createdRequest));
    }
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
  } finally {runtimeSpy.mockRestore(); container.remove();}
});

it("keeps the send mask and permits cancellation while the owner proof is flushing", async () => {
  vi.clearAllMocks();
  const storage=getAppStorage(); let finish!:()=>void;
  const flushOwner=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  registerStoragePersistence(storage,{backend:"IndexedDB",pending:false,error:undefined,resetting:false,
    flush:flushOwner,retry:async()=>{},reset:async()=>{},subscribe:()=>()=>{},close:()=>{}});
  const preview={bootstrap:{generation:"generation-a",supported:[NATIVE_PREVIEW_OWNER_CAPABILITY]},
    snapshotConversationOwner:()=>({generation:"generation-a",fixtureId:null})} as unknown as NonNullable<appRuntime.AppRuntime["nativeAgentPreview"]>;
  const original=appRuntime.getAppRuntime();
  const spy=vi.spyOn(appRuntime,"getAppRuntime").mockReturnValue({...original,storage,nativeAgentPreview:preview});
  mocks.read.mockResolvedValue({schemaVersion:1,conversationId:id,manuscriptId:id,revision:0,paused:false,preparingInputId:null,inputs:[]});
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {
    await act(async()=>root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={()=>({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})} files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]} messages={[]} projection={null} historyReady open onOpenChange={()=>undefined}/>));
    await vi.waitFor(()=>expect(mocks.read).toHaveBeenCalled());
    const input=container.querySelector("textarea")!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Keep this draft");input.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async()=>container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(flushOwner).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("正在核对请求");
    await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    await act(async()=>{finish();await Promise.resolve();});
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    expect(mocks.startWriting).not.toHaveBeenCalled();
    expect(input.value).toBe("Keep this draft");
  } finally {spy.mockRestore();await act(async()=>root.unmount());container.remove();}
});

it.each([true,false])("routes owner-proof errors inside the conversation while preserving other errors (missing=%s)", async missing => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({schemaVersion:1,conversationId:id,manuscriptId:id,revision:0,paused:false,preparingInputId:null,inputs:[]});
  mocks.prepareWriting.mockRejectedValue(missing ? Object.assign(new Error("agent_preview_owner_intent_missing"),{code:"AGENT_PREVIEW_OWNER_INTENT_MISSING"}) : new Error("network unavailable"));
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {
    await act(async()=>root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={()=>({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})} files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]} messages={[]} projection={null} historyReady open onOpenChange={()=>undefined}/>));
    await vi.waitFor(()=>expect(mocks.read).toHaveBeenCalled());
    const input=container.querySelector("textarea")!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Keep original");input.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async()=>container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await vi.waitFor(()=>expect(mocks.prepareWriting, JSON.stringify(vi.mocked(notify.error).mock.calls)).toHaveBeenCalledOnce());
    if (missing) {
      await vi.waitFor(()=>expect(container.querySelector('[role="alert"][aria-label="原请求归属恢复"]')).not.toBeNull());
      expect(container.textContent).toContain("原请求的归属尚无法确认");
      expect(vi.mocked(notify.error).mock.calls.some(([message])=>String(message).includes("AGENT_PREVIEW_OWNER_INTENT_MISSING"))).toBe(false);
    } else {
      await vi.waitFor(()=>expect(notify.error).toHaveBeenCalled());
      expect(container.querySelector('[role="alert"][aria-label="原请求归属恢复"]')).toBeNull();
    }
    expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());container.remove();}
});

it("keeps drafts and history when metadata cannot be verified and retries without submitting", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const retry = vi.fn();
  const render = (unavailable: string | undefined, loading = false) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id}
    conversationTitle="Paper" activePath="main.tex" content="source" contentHash="hash" files={[]}
    messages={[{ id: "saved", role: "user", content: "Saved history" }]} projection={null} historyReady open
    metadataUnavailable={unavailable} metadataLoading={loading} onRetryMetadata={retry} onOpenChange={() => undefined} />);
  try {
    await act(async () => render(undefined)); const input = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Keep pending draft"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => render("核对失败"));
    expect(container.querySelector("textarea")).toBe(input); expect(input.value).toBe("Keep pending draft");
    expect(container.textContent).toContain("Saved history");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "重新核对对话状态")).toBe(false);
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => render("核对中", true));
    expect(container.textContent).not.toContain("核对中");
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "重新核对对话状态")).toBe(false);
    await act(async () => render(undefined)); expect(input.value).toBe("Keep pending draft");
    expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("restores independent drafts when switching conversations and manuscripts without sending", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (manuscriptId: string, conversationId: string | null, open = true) => root.render(<WritingAgentRuntimePanel
    manuscriptId={manuscriptId} conversationId={conversationId} conversationTitle="Paper" activePath="main.tex"
    content="source" contentHash="hash" files={[]} messages={[]} projection={null} historyReady open={open} onOpenChange={() => undefined} />);
  const text = () => container.querySelector("textarea")!;
  async function type(value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(text(), value);
      text().dispatchEvent(new Event("input", { bubbles: true })); });
  }
  try {
    await act(async () => render(id, "a")); await type("First draft");
    await act(async () => render(id, "b")); expect(text().value).toBe(""); await type("Second draft");
    await act(async () => render("other", "a")); expect(text().value).toBe(""); await type("Other manuscript");
    await act(async () => render(id, "a")); expect(text().value).toBe("First draft");
    await act(async () => render(id, "a", false)); await act(async () => render(id, "a"));
    expect(text().value).toBe("First draft");
    await act(async () => render(id, "b")); expect(text().value).toBe("Second draft");
    await act(async () => render(id, null)); expect(text().value).toBe("");
    expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("preserves the current draft and transcript across archive and restore without sending", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (archived: boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[{ id: "saved", role: "user", content: "Saved question" }]}
    projection={null} historyReady open archived={archived} onOpenChange={() => undefined} />);
  try {
    await act(async () => render(false));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Keep this draft");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => render(true));
    expect(container.querySelector("textarea")).toBe(textarea); expect(textarea.value).toBe("Keep this draft");
    expect(textarea.disabled).toBe(true);
    expect(container.textContent).toContain("Saved question"); expect(container.textContent).toContain("此对话已归档");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
    await act(async () => render(false));
    expect(container.querySelector("textarea")).toBe(textarea); expect(textarea.value).toBe("Keep this draft");
    expect(textarea.disabled).toBe(false);
    expect(container.textContent).not.toContain("此对话已归档"); expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("derives the first conversation title from the first ordinary message", async () => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: [] });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  mocks.prepareWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id,
    manuscriptId: id, requestId: request.requestId, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  mocks.rename.mockImplementation(async request => renameProof(request));
  vi.mocked(agentMetadataGateway.read).mockResolvedValueOnce({ id, title: "完善引言中的研究问题", archived: false, durableCount: 0, createdAt: "now", updatedAt: "now" });
  const onTitle = vi.fn();
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="新对话"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]} messages={[]} projection={null}
      historyReady open onOpenChange={() => undefined} onConversationTitleChanged={onTitle} />));
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "请帮我完善引言中的研究问题");
    await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.rename).toHaveBeenCalledWith({ operationId: expect.any(String), id, expectedTitle: "新对话", title: "完善引言中的研究问题" });
    expect(mocks.rename.mock.calls[0]![0].operationId).not.toBe(mocks.prepareWriting.mock.calls[0]![0].requestId);
    expect(onTitle).toHaveBeenCalledWith(expect.objectContaining({ title: "完善引言中的研究问题" }));
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not expose legacy workspace history actions in a reopened conversation", async () => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({schemaVersion:1,entries:[],nextCursor:null});
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {
    await act(async()=>root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={null}
      historyReady open onOpenChange={()=>undefined}/>));
    expect([...container.querySelectorAll("button")].find((button)=>button.textContent==="历史副本变更")).toBeUndefined();
    expect(container.textContent).not.toContain("历史副本变更");
    expect(container.querySelector('summary[aria-label="更多会话操作"]')).toBeNull();
    expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());container.remove();}
});

it("routes mock mode through the production panel without native gateway calls", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const onSubmit = vi.fn();
  try {
    await act(async () => root.render(<WritingAgentPanel activePath="main.tex" draft="mock submission" isRunning={false} messages={[{id:"mock-user",role:"user",content:"Mock history"}]} onDraftChange={vi.fn()} onSubmit={text=>onSubmit(text)} onOpenChange={vi.fn()} open />));
    expect(container.querySelector(".writing-agent-panel")).not.toBeNull();
    expect(container.querySelector(".writing-agent-composer")).not.toBeNull();
    expect(container.textContent).toContain("Mock history");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSubmit).toHaveBeenCalledWith("mock submission");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
