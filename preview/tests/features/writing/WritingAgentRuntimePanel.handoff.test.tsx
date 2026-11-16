/** @vitest-environment happy-dom */
import {act, useMemo} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {WorkspaceTabsProvider} from "@research-assistant/workbench-preview/workbench-c5927e";
import {AgentDraftProvider} from "@research-assistant/workbench-preview/agent-draft-provider";
import {projectConversationMessages} from "@research-assistant/workbench-preview/project-conversation-messages";
import {useAgentConversation} from "@research-assistant/workbench-preview/use-agent-conversation";
import {WritingDiffDemoStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-storage";
import {WritingDiffDemoAgentStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-agent-storage";
import {createWritingDiffDemoRuntime} from "@research-assistant/writing-projects-preview/writing-diff-demo-runtime";
import {SpeechInputAdapterProvider} from "@research-assistant/workbench-preview/speech-input-adapter";
import {writingDemoSpeechAdapter} from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import {WritingAgentRuntimePanel} from "@research-assistant/writing-projects-preview/writing-agent-runtime-panel";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

it("holds the queued input after a lost steer receipt until the original history confirms it", async () => {
  const manuscriptId=crypto.randomUUID(), conversationId=crypto.randomUUID(), inputId=crypto.randomUUID();
  const files=new WritingDiffDemoStorage(manuscriptId,[{path:"main.tex",before:"text",after:"text",kind:"modified",additions:0,deletions:0}]);
  const agent=new WritingDiffDemoAgentStorage(files,undefined), runtime=createWritingDiffDemoRuntime(files,agent,manuscriptId,conversationId);
  runtime.execution.historyOnly=true;
  const file=await files.files.readFile(manuscriptId,"main.tex");
  const preview=await runtime.execution.submission.prepareWriting({conversationId,requestId:crypto.randomUUID(),text:"Task",context:{manuscriptId,files:[{relativePath:"main.tex",expectedDiskSha256:file.sha256}]}});
  const scope={conversationId,manuscriptId,requestId:preview.requestId,contextSnapshotId:preview.contextSnapshotId};
  await runtime.execution.workspace.prepare({scope,buffers:[]});
  await runtime.execution.submission.startWriting({...scope,model:preview.input.model,mode:"deepSeekNonThinking"});
  await runtime.queue.gateway.edit({manuscriptId,conversationId,requestId:crypto.randomUUID(),expectedRevision:0,edit:{type:"add",inputId,text:"保留原队列消息"}});
  runtime.execution.nextSteerFailure="afterCommit";
  const handoff=runtime.gateways.context!.steeringHandoff!, prepare=vi.spyOn(handoff,"prepare"), finish=vi.spyOn(handoff,"finish");
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  function Harness(){
    const history=useAgentConversation(conversationId,undefined,runtime.history);
    const messages=useMemo(()=>projectConversationMessages(history.projection),[history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} manuscriptId={manuscriptId} conversationId={conversationId}
      activePath={undefined} content="" contentHash={undefined} files={[]} messages={messages} projection={history.projection}
      historyReady={history.status==="ready"} open onOpenChange={()=>{}}/>;
  }
  try {
    await act(async()=>root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
    await vi.waitFor(()=>expect(host.querySelector<HTMLButtonElement>('[aria-label="将第 1 条消息插入当前轮次"]')?.disabled).toBe(false));
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="将第 1 条消息插入当前轮次"]')!.click());
    await vi.waitFor(()=>expect(host.textContent).toContain("无法确认引导是否已接收"));
    expect(host.querySelector('[data-pending-steering]')?.textContent).toContain("保留原队列消息");
    expect(host.querySelector('.agent-input-queue-body')?.textContent ?? "").not.toContain("保留原队列消息");
    const draft=host.querySelector("textarea")!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(draft,"新的草稿");draft.dispatchEvent(new Event("input",{bubbles:true}));});
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();expect(finish).not.toHaveBeenCalled();
    expect((await runtime.queue.gateway.read({manuscriptId,conversationId})).inputs.map(input=>input.inputId)).toEqual([inputId]);
    await act(async()=>runtime.execution.consumeSteersAtFixtureBoundary(conversationId,preview.turnId));
    await vi.waitFor(()=>expect(finish).toHaveBeenCalledOnce(),{timeout:6000});
    await vi.waitFor(()=>expect(host.querySelector('[aria-label="队列引导核对"]')).toBeNull());
    expect((await runtime.queue.gateway.read({manuscriptId,conversationId})).inputs).toHaveLength(0);
  } finally {await act(async()=>root.unmount());host.remove();runtime.dispose();vi.restoreAllMocks();}
});

it("accepts new queue input and direct steering while an admitted queued steer waits for history", async () => {
  const manuscriptId=crypto.randomUUID(), conversationId=crypto.randomUUID(), inputId=crypto.randomUUID();
  const files=new WritingDiffDemoStorage(manuscriptId,[{path:"main.tex",before:"text",after:"text",kind:"modified",additions:0,deletions:0}]);
  const agent=new WritingDiffDemoAgentStorage(files,undefined), runtime=createWritingDiffDemoRuntime(files,agent,manuscriptId,conversationId);
  runtime.execution.historyOnly=true;
  const file=await files.files.readFile(manuscriptId,"main.tex");
  const preview=await runtime.execution.submission.prepareWriting({conversationId,requestId:crypto.randomUUID(),text:"Task",context:{manuscriptId,files:[{relativePath:"main.tex",expectedDiskSha256:file.sha256}]}});
  const scope={conversationId,manuscriptId,requestId:preview.requestId,contextSnapshotId:preview.contextSnapshotId};
  await runtime.execution.workspace.prepare({scope,buffers:[]});
  await runtime.execution.submission.startWriting({...scope,model:preview.input.model,mode:"deepSeekNonThinking"});
  await runtime.queue.gateway.edit({manuscriptId,conversationId,requestId:crypto.randomUUID(),expectedRevision:0,edit:{type:"add",inputId,text:"第一条引导"}});
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  function Harness(){
    const history=useAgentConversation(conversationId,undefined,runtime.history);
    const messages=useMemo(()=>projectConversationMessages(history.projection),[history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} manuscriptId={manuscriptId} conversationId={conversationId}
      activePath={undefined} content="" contentHash={undefined} files={[]} messages={messages} projection={history.projection}
      historyReady={history.status==="ready"} open onOpenChange={()=>{}}/>;
  }
  const type=async(value:string)=>{const draft=host.querySelector("textarea")!;await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(draft,value);draft.dispatchEvent(new Event("input",{bubbles:true}));
  });return draft;};
  try {
    await act(async()=>root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
    await vi.waitFor(()=>expect(host.querySelector<HTMLButtonElement>('[aria-label="将第 1 条消息插入当前轮次"]')?.disabled).toBe(false));
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="将第 1 条消息插入当前轮次"]')!.click());
    await vi.waitFor(()=>expect(host.querySelector('[data-pending-steering]')?.textContent).toContain("第一条引导"));
    const next=await type("下一条排队消息");
    await vi.waitFor(()=>expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(false));
    await act(async()=>next.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
    await vi.waitFor(async()=>expect((await runtime.queue.gateway.read({manuscriptId,conversationId})).inputs.map(input=>input.text)).toEqual(["第一条引导","下一条排队消息"]));
    const direct=await type("第二条直接引导");
    await vi.waitFor(()=>expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(false));
    await act(async()=>direct.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true})));
    await vi.waitFor(()=>expect([...host.querySelectorAll('[data-pending-steering]')].map(item=>item.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("第一条引导"),expect.stringContaining("第二条直接引导")])));
    const third=await type("第三条直接引导");
    await vi.waitFor(()=>expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(false));
    await act(async()=>third.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true})));
    await vi.waitFor(()=>expect([...host.querySelectorAll('[data-pending-steering]')].map(item=>item.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("第一条引导"),expect.stringContaining("第二条直接引导"),expect.stringContaining("第三条直接引导")])));
    await act(async()=>runtime.execution.consumeSteersAtFixtureBoundary(conversationId,preview.turnId));
    await vi.waitFor(async()=>expect((await runtime.queue.gateway.read({manuscriptId,conversationId})).inputs.map(input=>input.text)).toEqual(["下一条排队消息"]));
    expect(host.textContent).toContain("第二条直接引导");
    expect(host.textContent).toContain("第三条直接引导");
  } finally {await act(async()=>root.unmount());host.remove();runtime.dispose();vi.restoreAllMocks();}
});

it("steers multiple queued messages and refreshes the revision after a partial completion", async () => {
  const manuscriptId=crypto.randomUUID(),conversationId=crypto.randomUUID();
  const files=new WritingDiffDemoStorage(manuscriptId,[{path:"main.tex",before:"text",after:"text",kind:"modified",additions:0,deletions:0}]);
  const agent=new WritingDiffDemoAgentStorage(files,undefined),runtime=createWritingDiffDemoRuntime(files,agent,manuscriptId,conversationId);
  runtime.execution.historyOnly=true;
  const file=await files.files.readFile(manuscriptId,"main.tex");
  const preview=await runtime.execution.submission.prepareWriting({conversationId,requestId:crypto.randomUUID(),text:"Task",context:{manuscriptId,files:[{relativePath:"main.tex",expectedDiskSha256:file.sha256}]}});
  const scope={conversationId,manuscriptId,requestId:preview.requestId,contextSnapshotId:preview.contextSnapshotId};
  await runtime.execution.workspace.prepare({scope,buffers:[]});
  await runtime.execution.submission.startWriting({...scope,model:preview.input.model,mode:"deepSeekNonThinking"});
  for(const [index,text] of ["第一条", "第二条", "第三条"].entries())await runtime.queue.gateway.edit({manuscriptId,conversationId,requestId:crypto.randomUUID(),expectedRevision:index,edit:{type:"add",inputId:crypto.randomUUID(),text}});
  const gateway=runtime.gateways.context!.steeringHandoff!,prepare=vi.spyOn(gateway,"prepare"),finish=vi.spyOn(gateway,"finish");
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  function Harness(){const history=useAgentConversation(conversationId,undefined,runtime.history);
    const messages=useMemo(()=>projectConversationMessages(history.projection),[history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} manuscriptId={manuscriptId} conversationId={conversationId}
      activePath={undefined} content="" contentHash={undefined} files={[]} messages={messages} projection={history.projection}
      historyReady={history.status==="ready"} open onOpenChange={()=>{}}/>;}
  const clickNext=async()=>{await vi.waitFor(()=>expect(host.querySelector<HTMLButtonElement>('[aria-label="将第 1 条消息插入当前轮次"]')?.disabled).toBe(false),{timeout:6000});
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="将第 1 条消息插入当前轮次"]')!.click());};
  try {
    await act(async()=>root.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));
    await clickNext();await vi.waitFor(()=>expect(prepare).toHaveBeenCalledTimes(1));
    await clickNext();await vi.waitFor(()=>expect(prepare).toHaveBeenCalledTimes(2));
    expect([...host.querySelectorAll('[data-pending-steering]')].map(item=>item.textContent)).toEqual([expect.stringContaining("第一条"),expect.stringContaining("第二条")]);
    const first=prepare.mock.calls[0]![0];
    await act(async()=>agent.history.steer({scope,turnId:preview.turnId},first.steeringInputId,first.text));
    await vi.waitFor(()=>expect(finish).toHaveBeenCalledTimes(1),{timeout:6000});
    await clickNext();await vi.waitFor(()=>expect(prepare).toHaveBeenCalledTimes(3),{timeout:6000});
    expect(prepare.mock.calls[2]![0]).toMatchObject({text:"第三条",expectedRevision:4});
    expect((await runtime.queue.gateway.read({manuscriptId,conversationId})).inputs.map(input=>input.text)).toEqual(["第二条","第三条"]);
  } finally {await act(async()=>root.unmount());host.remove();runtime.dispose();vi.restoreAllMocks();}
});
