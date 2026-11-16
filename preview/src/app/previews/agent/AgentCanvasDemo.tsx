import { AgentCanvasPreviewFrame } from "@research-assistant/workbench-preview/agent-canvas-preview-frame";
import { AgentCanvasScenarioControls, CanvasControlGroup } from "@research-assistant/workbench-preview/agent-canvas-scenario-controls";
import { isAgentCanvasScenario, type AgentCanvasScenario } from "@research-assistant/workbench-preview/agent-canvas-scenario";
import { writingDemoSingleMessage } from "@research-assistant/workbench-preview/writing-demo-messages";
import {useTextDocuments} from "@research-assistant/workbench-preview/use-text-documents";
import {WorkspaceTabsProvider,WorkspaceTabBar} from "@research-assistant/workbench-preview/workspace-tabs";
import { AgentCanvasShell, AgentCanvasHost } from "@research-assistant/workbench-preview/agent-canvas-shell";
import { BoundConversationList } from "@research-assistant/workbench-preview/bound-conversation-list";
import {AgentCanvasRecovery} from "@research-assistant/workbench-preview/agent-canvas-recovery";
import { AgentCanvasQueueErrors } from "@research-assistant/workbench-preview/agent-canvas-queue-errors";
import {seedDemoToolHistory} from "@research-assistant/workbench-preview/writing-demo-tool-history";
import {useEffect,useState,useRef} from "react";
import {AgentDraftProvider} from "@research-assistant/workbench-preview/agent-draft-provider";
import { WritingDemoSubmissionStates, type WritingDemoSubmissionScenario } from "../../../../agent/WritingDemoSubmissionStates";
import { WritingDemoMetadataState } from "../../../../agent/WritingDemoMetadataState";
import { StreamRevealDurationProvider } from "@research-assistant/workbench-preview/stream-reveal";
import { DEFAULT_CANVAS_TEXT_SETTINGS, type CanvasTextSettings } from "@research-assistant/workbench-preview/agent-canvas-text-settings";
import { DEFAULT_DEMO_TEXT_PACING, type WritingDemoTextPacing } from "@research-assistant/workbench-preview/writing-demo-text-stream";
import { SpeechInputAdapterProvider } from "@research-assistant/workbench-preview/speech-input-adapter";
import { writingDemoSpeechAdapter } from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import {WritingDiffDemoStorage} from "../../../../agent/WritingDiffDemoStorage";
import {WritingDiffDemoAgentStorage} from "./WritingDiffDemoAgentStorage";
import {createWritingDiffDemoRuntime} from "./writingDiffDemoRuntime";
import {writingDemoMarkdownMessages} from "@research-assistant/workbench-preview/writing-demo-markdown-messages";
import {WritingAgentRuntimePanel} from "../../../../../src/features/writing/WritingAgentRuntimePanel";
import {useWritingAgentHistory} from "../../../../../src/features/writing/useWritingAgentHistory";
import {insertAgentReference, serializeAgentSourceReferences, type AgentSubmissionPreview} from "@research-assistant/core/agent";
import "@research-assistant/workbench-preview/styles/agent-canvas-demo";
import { getAppRuntime } from "@research-assistant/workbench-preview/app-runtime";
import { NativeAgentCanvasPreview } from "./NativeAgentCanvasPreview";
const manuscriptId="00000000-0000-4000-8000-000000000002",conversationId="00000000-0000-4000-8000-000000000001";
type Scenario=AgentCanvasScenario;
function createBackend(scenario:Scenario="running",durationMinutes=scenario==="multiple"||scenario==="markdown"?.05:60,pacing:WritingDemoTextPacing=DEFAULT_DEMO_TEXT_PACING,compactionDurationMs=DEFAULT_CANVAS_TEXT_SETTINGS.compactionDurationMs){
 const text="\\documentclass{article}\n\\keywords{research, agent}\n";
 const storage=new WritingDiffDemoStorage(manuscriptId,[{path:"sn-article.tex",kind:"modified",before:text,after:text,additions:0,deletions:0}]);
 const agent=new WritingDiffDemoAgentStorage(storage,undefined);
 const runtime=createWritingDiffDemoRuntime(storage,agent,manuscriptId,conversationId);runtime.execution.delayMs=durationMinutes*60000;
 if(scenario==="internalRunning")runtime.conversations.markInternal(conversationId);
 runtime.setCompactionDuration(compactionDurationMs);
 const submissionStates=scenario.startsWith("submission")?new WritingDemoSubmissionStates(runtime.gateways,scenario as WritingDemoSubmissionScenario,durationMinutes*60000):undefined;
 const metadataState=scenario==="metadataChecking"||scenario==="metadataFailed"?new WritingDemoMetadataState(runtime.gateways.metadata,scenario==="metadataFailed",durationMinutes*60000):undefined;
 const historyAccess=metadataState?{...runtime.history,metadata:metadataState.gateway}:runtime.history;
 const gateways=metadataState?{...runtime.gateways,metadata:metadataState.gateway}:submissionStates?.gateways??runtime.gateways;
 runtime.execution.setTextPacing(pacing);
 runtime.execution.progressiveFeedback=true;
 runtime.execution.historyOnly=scenario==="toolHistory"||scenario==="toolHistoryDone";
 runtime.execution.multipleResponses=scenario==="multiple"||scenario==="markdown";
 runtime.execution.responseTexts=scenario==="markdown"?writingDemoMarkdownMessages:undefined;
 runtime.execution.singleTextResponse=scenario==="single"?writingDemoSingleMessage:undefined;
 let active:AgentSubmissionPreview|null=null;
 const initialized=(async()=>{
  const file=await storage.files.readFile(manuscriptId,"sn-article.tex");
  if(submissionStates||metadataState)return;
  const reference={type:"skill" as const,name:runtime.resources.name,identity:{environment_id:"application",source_id:runtime.resources.sourceId,revision:runtime.resources.revision}};
  const resourceInput=scenario==="evidence" ? [{type:"text" as const,text:"开始处理当前稿件",textElements:[]},
    {type:"annotation" as const,source:`source://writings/${manuscriptId}/sn-article.tex:#line{2-1:2-26}`,title:"关键词定义",text:"\\keywords{research, agent}",comment:"请结合文章内容检查这些关键词。"},
    {type: "annotation" as const, comment: "",source:`source://writings/${manuscriptId}/sn-article.tex:#line{2-1:2-26}`,title:"sn-article.tex · 关键词",text:"\\keywords{research, agent}"},
    {type: "annotation" as const, comment: "",source:`source://writings/${manuscriptId}/sn-article.tex:#line{1-1:1-23}`,title:"sn-article.tex · 文档类型",text:"\\documentclass{article}"}]
    : scenario==="resources"?[{type:"text" as const,text:"开始处理当前稿件",textElements:[]},reference,{type:"mention" as const,name:"模拟文献检索",target:{kind:"tool" as const,serverId:"模拟文献检索",environmentId:"mock",revision:"1"}}]:[];
  const longFile=scenario==="longMessage"?(await runtime.resources.gateways.hostResources!({kind:"manuscript",resourceId:manuscriptId,conversationId})).find(resource=>resource.label==="sn-article.tex")?.input:undefined;
  if(scenario==="longMessage"&&!longFile)throw new Error("Long-message fixture requires sn-article.tex");
  const longDraft=insertAgentReference(insertAgentReference({text:"🧪 请结合以下引用检查稿件。\n",bindings:[]},reference),
    longFile??reference);
  const longText=longDraft.text+"\n"+Array.from({length:20},(_,index)=>`第 ${index+1} 项：检查研究问题、方法、证据和结论的对应关系，并保留引用来源。`).join("\n");
  const longInput=serializeAgentSourceReferences({...longDraft,text:longText},{kind:"manuscript",resourceId:manuscriptId,conversationId});
  active=await runtime.gateways.submission.prepareWriting({conversationId,requestId:crypto.randomUUID(),text:scenario==="longMessage"?longInput.text:"开始处理当前稿件",userInput:scenario==="longMessage"?longInput.userInput:resourceInput,model:{providerId:"deepseek",modelId:"deepseek-v4-pro"},context:{manuscriptId,files:[{relativePath:"sn-article.tex",expectedDiskSha256:file.sha256}]}});
  const scope={manuscriptId,conversationId,requestId:active.requestId,contextSnapshotId:active.contextSnapshotId};
  const workspace=await runtime.gateways.workspace.prepare({scope,buffers:[{path:"sn-article.tex",text:file.content,
   expectedDiskSha256:file.sha256,sessionId:crypto.randomUUID(),revision:crypto.randomUUID()}]});
  await runtime.gateways.workspace.approve({scope,turnId:active.turnId,leaseId:workspace.leaseId,manifestHash:workspace.manifestHash});
  await runtime.gateways.submission.startWriting({...scope,model:active.input.model,mode:"deepSeekNonThinking"});
  if(scenario==="toolHistory"||scenario==="toolHistoryDone"){
   const admission={scope,turnId:active.turnId};
   const finishTool=seedDemoToolHistory(agent.history,admission,scenario==="toolHistory");
   if(finishTool)runtime.execution.continueSeededHistory(admission,finishTool);
   if(scenario==="toolHistoryDone")await runtime.execution.finishScenario("completed");
  }
  if(scenario==="invalidSkill")runtime.resources.revision="2";
  if(scenario!=="toolHistory"&&scenario!=="toolHistoryDone"&&scenario!=="single"&&scenario!=="running"&&scenario!=="longMessage"&&scenario!=="internalRunning"&&scenario!=="resources"&&scenario!=="invalidSkill"&&scenario!=="multiple"&&scenario!=="markdown"){
   const current=await runtime.queue.gateway.read({manuscriptId,conversationId});
   await runtime.queue.gateway.edit({manuscriptId,conversationId,requestId:crypto.randomUUID(),expectedRevision:current.revision,edit:{type:"pause"}});
   await runtime.execution.finishScenario(scenario === "evidence" ? "completed" : scenario as "completed"|"canceled"|"failed");
  }
 })();
 return {storage,agent,runtime,submissionStates,metadataState,historyAccess,gateways,initialized,scenario,durationMinutes,active:()=>active};
}
/** Outer showcase only. The real runtime, input controller, queue, steering and
 * history projection are exercised through replaceable mock native gateways. */
export function AgentCanvasDemo():React.JSX.Element{
 if(getAppRuntime().nativeAgentPreview)return <NativeAgentCanvasPreview/>;
 return <MockAgentCanvasDemo/>;
}
function MockAgentCanvasDemo():React.JSX.Element{
 const [backend,setBackend]=useState(createBackend),[settings,setSettings]=useState(DEFAULT_CANVAS_TEXT_SETTINGS);
 function changeTextSettings(next:CanvasTextSettings){
  if(next.pacing!==settings.pacing)backend.runtime.execution.setTextPacing(next.pacing);
  backend.runtime.setCompactionDuration(next.compactionDurationMs);
  setSettings(next);
 }
 return <WorkspaceTabsProvider><StreamRevealDurationProvider durationMs={settings.revealDurationMs}><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider key={backend.runtime.identity}><CanvasHost backend={backend} settings={settings} onTextSettingsChange={changeTextSettings} reset={(scenario=backend.scenario,durationMinutes=backend.durationMinutes)=>setBackend(createBackend(scenario,durationMinutes,settings.pacing,settings.compactionDurationMs))}/></AgentDraftProvider></SpeechInputAdapterProvider></StreamRevealDurationProvider></WorkspaceTabsProvider>;
}
function CanvasHost({backend,reset,settings,onTextSettingsChange}:{readonly backend:ReturnType<typeof createBackend>;readonly reset:(scenario?:Scenario,durationMinutes?:number)=>void;readonly settings:CanvasTextSettings;readonly onTextSettingsChange:(settings:CanvasTextSettings)=>void}){
 const textDocuments=useTextDocuments("writing");
 const {runtime,storage}=backend,history=useWritingAgentHistory(manuscriptId,backend.historyAccess);
 const [ready,setReady]=useState(false),[duration,setDuration]=useState(backend.durationMinutes),[file,setFile]=useState<Awaited<ReturnType<typeof storage.files.readFile>>|null>(null),[files,setFiles]=useState<Awaited<ReturnType<typeof storage.files.listFiles>>>([]);
 const [editorIdentity]=useState(()=>({sessionId:crypto.randomUUID(),revision:crypto.randomUUID()}));
 const lifecycle=useRef(0);
 useEffect(()=>{const epoch=++lifecycle.current,release=runtime.retain();history.setOpen(true);void backend.initialized.then(async()=>{const [value,list]=await Promise.all([storage.files.readFile(manuscriptId,"sn-article.tex"),storage.files.listFiles(manuscriptId)]);if(lifecycle.current===epoch){setFile(value);setFiles(list);setReady(true);}});return()=>{release();queueMicrotask(()=>{if(lifecycle.current===epoch){backend.submissionStates?.dispose();backend.metadataState?.dispose();runtime.dispose();}});};},[backend]);
 const [listRefresh,setListRefresh]=useState(0);
 function refreshConversations(){void history.refreshMetadata();setListRefresh(value=>value+1);}
 const running=!!history.conversation.projection&&[...history.conversation.projection.turns.values()].some(turn=>turn.outcome===null);
 return <AgentCanvasPreviewFrame tabs={textDocuments.activeId!==undefined&&<WorkspaceTabBar owner="writing" textActive navigate={()=>{textDocuments.deactivate();return true;}}/>}
  controls={<AgentCanvasScenarioControls scenario={backend.scenario} duration={duration} settings={settings} unavailable={{longHistory:"需要隔离原生预览",childCreationUnknown:"需要隔离原生预览", childCleanupUnknown:"需要隔离原生预览"}}
   onReset={()=>reset(backend.scenario,duration)} onDuration={value=>{setDuration(value);runtime.execution.reschedule(value*60000);backend.submissionStates?.setDuration(value*60000);backend.metadataState?.setDuration(value*60000);}}
   onSettings={onTextSettingsChange} onScenario={value=>{if(!isAgentCanvasScenario(value))return;reset(value,value==="single"||value==="multiple"||value==="markdown"?.05:duration);}}>
   <CanvasControlGroup title="错误与场景操作"><div className="agent-canvas-control-row">
   {backend.submissionStates&&<span>请在输入框输入消息并发送，以触发所选状态。</span>}
   {backend.scenario==="internalRunning"&&<span>点击对话列表左上角的机器人查看内部对话；停止生成后可预览空闲状态。</span>}
   {(backend.scenario==="submissionPreparing"||backend.scenario==="submissionCheckingFailed")&&<button className="agent-canvas-demo-reset" type="button" onClick={()=>backend.submissionStates?.continue()}>{backend.scenario==="submissionCheckingFailed"?"模拟核对失败":"继续模拟发送"}</button>}
   {backend.metadataState&&<button className="agent-canvas-demo-reset" type="button" onClick={()=>backend.metadataState?.continue()}>完成模拟核对</button>}
   {history.selectedId && <AgentCanvasQueueErrors key={history.selectedId} faults={{setNextEditFailure:value=>runtime.queue.failNextEdit(value)}} registry={runtime.gateways.queue.registry} scope={{manuscriptId,conversationId:history.selectedId}} ready={ready && history.conversation.status === "ready" && !history.isArchived} />}
   {history.selectedId && <AgentCanvasRecovery key={runtime.identity} faults={{setSteerFailure:value=>{runtime.execution.nextSteerFailure=value==="normal"?null:value;},disconnect:mode=>runtime.execution.simulateReconnect(history.selectedId!,mode==="exhaust")}} active={ready && running && !history.isArchived} onSimulate={()=>history.setOpen(true)}/> }
   </div></CanvasControlGroup>
  </AgentCanvasScenarioControls>}><AgentCanvasShell placement="contained">{textDocuments.surface}<AgentCanvasHost selectedId={history.selectedId} open={history.isOpen} onOpenChange={history.setOpen} onNewConversation={history.newConversation} conversations={<BoundConversationList onCreate={history.newConversation} binding={{kind:"manuscript",resourceId:manuscriptId}} selectedId={history.selectedId} pendingConversationId={history.pendingConversationId} onSelect={history.select} onArchiveChange={history.setArchived} onDeleted={history.deleted} onRefreshSelected={()=>void history.refreshMetadata()} refreshToken={listRefresh} revealConversation={history.revealedConversation} {...runtime.listGateways} />}>{controls=><WritingAgentRuntimePanel {...controls} dismissOnOutsideClick={false} gateways={backend.gateways} manuscriptId={manuscriptId} conversationId={history.selectedId} pendingConversationId={history.pendingConversationId} onConversationCreationFinished={history.newConversation} onConversationCreated={conversation=>{history.conversationCreated(conversation);refreshConversations();}} onConversationTitleChanged={refreshConversations} open={history.isOpen} onOpenChange={history.setOpen} onOpenConversation={history.openRelatedConversation} searchTarget={history.searchTarget} conversationTitle={history.metadata.conversation?.title} activePath="sn-article.tex" content={file?.content??""} contentHash={file?.sha256} files={files} readEditorSnapshot={()=>file?{documentKey:`${manuscriptId}:sn-article.tex`,...editorIdentity,text:file.content}:null} messages={history.messages} projection={history.conversation.projection} historyReady={ready&&(!!history.pendingConversationId||history.conversation.status==="ready")} archived={history.isArchived} metadataLoading={!history.pendingConversationId&&history.metadata.status==="loading"} metadataUnavailable={history.pendingConversationId?undefined:history.metadata.unavailableReason} onRetryMetadata={()=>void history.refreshMetadata()}/>}</AgentCanvasHost></AgentCanvasShell></AgentCanvasPreviewFrame>;
}
