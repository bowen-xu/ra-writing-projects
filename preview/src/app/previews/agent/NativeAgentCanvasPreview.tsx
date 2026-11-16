import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import { WorkspaceTabsProvider, WorkspaceTabBar } from "@research-assistant/workbench-preview/workspace-tabs";
import { useTextDocuments } from "@research-assistant/workbench-preview/use-text-documents";
import { StreamRevealDurationProvider } from "@research-assistant/workbench-preview/stream-reveal";
import { getAppRuntime } from "@research-assistant/workbench-preview/app-runtime";
import type { NativeAgentPreview } from "@research-assistant/workbench-preview/native-agent-preview";
import { agentMetadataGateway, agentSessionGateway } from "@research-assistant/workbench-preview/agent-gateway";
import { getWritingGateway } from "../../../../../src/public/writingGateway.ts";
import { getWritingCheckpointGateway } from "../../../../../src/public/writingCheckpointGateway.ts";
import { WritingConversationSession } from "../../../../../src/public/conversationSession.ts";
import { AgentConversationAdaptersProvider } from "@research-assistant/workbench-preview/agent-conversation-adapters";
import { readWritingSubmissionBuffers } from "../../../../../src/features/writing/agent/writingSubmissionSources";
import { WritingAgentRuntimePanel } from "../../../../../src/features/writing/WritingAgentRuntimePanel";
import { useWritingAgentHistory } from "../../../../../src/features/writing/useWritingAgentHistory";
import { SpeechInputAdapterProvider } from "@research-assistant/workbench-preview/speech-input-adapter";
import { writingDemoSpeechAdapter } from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import { AgentCanvasShell, AgentCanvasHost, useAgentCanvasHostVisible } from "@research-assistant/workbench-preview/agent-canvas-shell";
import { AgentCanvasPreviewFrame } from "@research-assistant/workbench-preview/agent-canvas-preview-frame";
import { AgentCanvasScenarioControls, CanvasControlGroup } from "@research-assistant/workbench-preview/agent-canvas-scenario-controls";
import { AgentCanvasQueueErrors } from "@research-assistant/workbench-preview/agent-canvas-queue-errors";
import { AgentCanvasDeletionErrors } from "@research-assistant/workbench-preview/agent-canvas-deletion-errors";
import { AgentCanvasRecovery } from "@research-assistant/workbench-preview/agent-canvas-recovery";
import { DEFAULT_CANVAS_TEXT_SETTINGS, type CanvasTextSettings } from "@research-assistant/workbench-preview/agent-canvas-text-settings";
import { BoundConversationList } from "@research-assistant/workbench-preview/bound-conversation-list";
import { AgentDraftProvider } from "@research-assistant/workbench-preview/agent-draft-provider";
import { AgentQueueProvider, useAgentQueueOwners } from "@research-assistant/workbench-preview/agent-queue-provider";
import { AgentSteeringProvider } from "@research-assistant/workbench-preview/agent-steering-provider";
import { nativeCanvasScenarioOptions, nativeCanvasScenarioSupported, nativeCanvasSamples, nativeCanvasNoteReadSamples, nativeCanvasMcpSamples } from "@research-assistant/workbench-preview/native-canvas-scenarios";
import { readAgentSessionSelection, writeAgentSessionSelection, clearAgentSessionSelection } from "@research-assistant/workbench-preview/agent-session-selection";
import { localConversationDraftPersistence } from "@research-assistant/workbench-preview/conversation-draft-persistence";
import { NativeCanvasScenarioAdapter } from "@research-assistant/workbench-preview/native-canvas-scenario-adapter";
import { isNativeCanvasChoice } from "@research-assistant/workbench-preview/native-canvas-scenario-manifest";
import { nativeCanvasSettings, NATIVE_CANVAS_DELETION_FAULTS_CAPABILITY, type NativeCanvasChoice, type NativeCanvasFixture } from "@research-assistant/workbench-preview/native-canvas-scenario-types";
import { agentCanvasPreviewError } from "@research-assistant/workbench-preview/agent-canvas-preview-error";
import { useWritingDocuments } from "../../../../fixtures/useWritingDocuments";
import {WritingFileRuntimeProvider} from "../../../../../src/features/writing/persistence/WritingFileRuntimeProvider";
import {getReaderCloseCoordinator} from "@research-assistant/workbench-preview/document-close-coordinator";
import { NativeCanvasEditor } from "./NativeCanvasEditor";
import { NativeCanvasResourceFixtureControl } from "@research-assistant/workbench-preview/native-canvas-resource-fixture-control";
import {agentContextGateway} from "@research-assistant/workbench-preview/agent-context-gateway";
import {nativeContextQueueFault} from "@research-assistant/workbench-preview/native-context-queue-fault";
import {nativeContextLegacyQueueFault} from "@research-assistant/workbench-preview/native-context-legacy-queue-fault";
import {nativeContextTaskFault} from "@research-assistant/workbench-preview/native-context-task-fault";
import {nativeContextStartObservationFault} from "@research-assistant/workbench-preview/native-context-start-observation-fault";
import {notify} from "@research-assistant/workbench-preview/notifications";
import {diagnosticError} from "@research-assistant/workbench-preview/diagnostic-error";

export function NativeAgentCanvasPreview(): React.JSX.Element {
  const preview=getAppRuntime().nativeAgentPreview;if(!preview)throw new Error("原生 Agent 预览尚未初始化。");
  return <AgentConversationAdaptersProvider WritingSession={WritingConversationSession}><WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><NativeAgentCanvasRuntime preview={preview}/></SpeechInputAdapterProvider></WorkspaceTabsProvider></AgentConversationAdaptersProvider>;
}
function NativeAgentCanvasRuntime({preview}:{readonly preview:NativeAgentPreview}):React.JSX.Element{
  const storage=getAppRuntime().storage;
  const [documentsClosing,setDocumentsClosing]=useState(false);
  const documentClose=useRef(new Set<()=>Promise<boolean>>());
  const registerDocumentClose=useCallback((prepare:()=>Promise<boolean>)=>{
    documentClose.current.add(prepare);return()=>{documentClose.current.delete(prepare);};
  },[]);
  const [adapter]=useState(()=>new NativeCanvasScenarioAdapter(preview,storage,undefined,{prepareClose:async()=>{
    flushSync(()=>setDocumentsClosing(true));const results=await Promise.all([...documentClose.current].map(prepare=>prepare()));return results.every(Boolean) && await getReaderCloseCoordinator().prepareAll();
  }}));
  const state=useSyncExternalStore(adapter.subscribe,adapter.getSnapshot,adapter.getSnapshot);
  const connection=useSyncExternalStore(preview.subscribe,preview.getSnapshot,preview.getSnapshot);
  const [settings,setSettings]=useState(DEFAULT_CANVAS_TEXT_SETTINGS),[duration,setDuration]=useState(60);
  const [generation,setGeneration]=useState(preview.bootstrap.generation),[hostReady,setHostReady]=useState<string|null>(null);
  const [sceneNavigationRevision,setSceneNavigationRevision]=useState(0);
  const [configuredCompaction,setConfiguredCompaction]=useState<string|null>(null);
  const [draftPersistence]=useState(()=>localConversationDraftPersistence(storage));
  useEffect(()=>{void adapter.initialize(nativeCanvasSettings(60,DEFAULT_CANVAS_TEXT_SETTINGS));},[adapter]);
  useEffect(()=>{const confirmed=state.settings;if(confirmed){setDuration(confirmed.durationMs/60000);setSettings(previous=>({...previous,
    pacing:{charactersPerChunk:confirmed.charactersPerChunk,intervalMs:confirmed.intervalMs},compactionDurationMs:confirmed.compactionDurationMs}));}},[state.settings]);
  useEffect(()=>{if(state.fixture&&hostReady===state.fixture.fixtureId&&!state.busy&&!state.disposing)void adapter.activateFixture(hostReady);},[adapter,state.fixture?.fixtureId,state.busy,state.disposing,hostReady]);
  async function changeSettings(next:CanvasTextSettings):Promise<void>{
    if(next.pacing===settings.pacing&&next.compactionDurationMs===settings.compactionDurationMs){setSettings(next);return;}
    if(await adapter.updateSettings(nativeCanvasSettings(duration,next)))setSettings(next);
  }
  async function reset():Promise<void>{
    try{await adapter.reset(nativeCanvasSettings(duration,settings),()=>undefined);
      setGeneration(preview.bootstrap.generation);}
    finally{setDocumentsClosing(false);}
  }
  async function changeScenario(choice:NativeCanvasChoice):Promise<void>{
    const minutes=choice==="single"||choice==="multiple"||choice==="markdown"?.05:duration;
    // Explicit scene selection supersedes older asynchronous chat navigation.
    // Publish before creating a fixture so a delayed old read cannot win.
    flushSync(()=>setSceneNavigationRevision(value=>value+1));
    try{if(await adapter.select(choice,nativeCanvasSettings(minutes,settings),()=>undefined))setDuration(minutes);}
    finally{setDocumentsClosing(false);}
  }
  const extraScenes=nativeCanvasScenarioOptions.map(([name,label])=>({value:`wire:${name}`,label,
    ...(!adapter.available()||!nativeCanvasScenarioSupported(name,preview.bootstrap.supported)?{unavailable:"需重启原生后端并刷新页面"}:{})}));
  const controls=(children?:React.ReactNode)=><AgentCanvasScenarioControls scenario={state.choice} duration={duration} settings={settings} disabled={state.busy||!adapter.available()}
    unavailable={{internalRunning:"内部业务 scope 夹具待接入",resources:"MCP 授权夹具待接入",
      ...(!preview.bootstrap.supported.includes("canvas-long-history")?{longHistory:"需重启原生后端并刷新页面"}:{}),
      childCreationUnknown:"子任务功能暂未开放",
      childCleanupUnknown:"子任务功能暂未开放"}}
    extraScenes={extraScenes} settingsDisabled={state.disposing} onSettings={next=>void changeSettings(next)} onDuration={minutes=>{void adapter.updateSettings(nativeCanvasSettings(minutes,settings)).then(ok=>{if(ok)setDuration(minutes);});}}
    onScenario={choice=>{if(isNativeCanvasChoice(choice))void changeScenario(choice);}} onReset={()=>void reset()}>
    <CanvasControlGroup title="当前场景" description="场景状态及需要手动继续的操作。"><div className="agent-canvas-control-row">
    {!adapter.available()&&<p className="agent-canvas-demo-status" role="status">原预览控件已保留；当前后端尚未接通完整场景，请重启原生预览并刷新页面。</p>}
    {state.issue!=null&&<p className="agent-canvas-demo-status" role="alert">{agentCanvasPreviewError(state.issue)}</p>}
    {state.issue!=null&&!state.fixture&&adapter.available()&&<button className="agent-canvas-demo-reset" type="button" disabled={state.busy} onClick={()=>void adapter.retrySetup()}>重新核对原场景</button>}
    {state.needsStart&&<button className="agent-canvas-demo-reset" type="button" disabled={state.busy} onClick={()=>void adapter.continueOriginal()}>继续原场景</button>}
    {state.choice==="longHistory"&&<span className="agent-canvas-demo-status">通过真实队列生成 60 轮、120 条消息。前 59 轮快速返回，第 60 轮使用当前输出节奏；可上滑阅读、输入草稿或刷新验证历史恢复。</span>}
    {state.fixture&&state.choice.startsWith("wire:")&&state.choice!=="wire:compactLegacy"&&state.choice!=="wire:compactSuccess"&&<button className="agent-canvas-demo-reset" type="button" disabled={state.busy||state.disposing} onClick={()=>void adapter.reloadOriginalSamples()}>重新装载合成响应</button>}
    {state.disposing&&<p className="agent-canvas-demo-status" role="status">{state.ownerDrained?"原文件已保全并关闭；请重试重置或切换场景以核对本机清理。":"原场景正在关闭；文件状态保留。请重试重置或切换场景以核对收尾。"}</p>}
    {(state.choice==="wire:compactSuccess"||state.choice==="wire:compactInvalid"||state.choice==="wire:compactLegacy")&&<>
      {preview.bootstrap.supported.includes("legacy-compaction-config-fixture")&&<button className="agent-canvas-demo-reset" type="button" disabled={!state.fixture||state.busy||state.disposing}
        onClick={()=>{const fixture=state.fixture;if(!fixture)return;const v2=state.choice!=="wire:compactLegacy";
          void adapter.setRemoteCompaction(v2).then(ok=>{if(ok)setConfiguredCompaction(`${fixture.fixtureId}:${v2}`);});}}>
        {state.choice==="wire:compactLegacy"?"准备旧式压缩配置":"准备 V2 压缩配置"}</button>}
      <span className="agent-canvas-demo-status">{state.choice==="wire:compactLegacy"?"场景先运行一条合成对话以准备历史；切换场景后重新选择可开始新的测试。":""}{state.choice!=="wire:compactSuccess"&&preview.bootstrap.supported.includes("legacy-compaction-config-fixture")&&configuredCompaction!==`${state.fixture?.fixtureId}:${state.choice!=="wire:compactLegacy"}`?"先准备对应压缩配置，再发送 /compact。":"在聊天输入框发送 /compact，使用实际压缩准备与启动流程。"}配置作用于隔离预览中新准备的请求。</span>
    </>}
    {state.choice==="childCreationUnknown"&&<span className="agent-canvas-demo-status">合成创建结果未知（未执行实际创建），仅作用于本场景；核对入口使用实际 Agent 历史和数据接口。</span>}
    {state.choice==="childCleanupUnknown"&&<span className="agent-canvas-demo-status">合成子提交失败及清理结果未知（未执行实际提交和归档），仅作用于本场景；核对入口使用实际 Agent 历史和数据接口。</span>}
    <p className="agent-canvas-demo-status">内部业务 scope 与 MCP 授权夹具待接入；原场景标签保留。工具历史的完整文件交付 owner 仍待验收。</p>
    {connection.error!=null&&<p className="agent-canvas-demo-status" role="alert">{agentCanvasPreviewError(connection.error)}<button type="button" onClick={()=>preview.reconnect()}>重连事件</button></p>}
    </div></CanvasControlGroup>
    {children}
  </AgentCanvasScenarioControls>;
  return <StreamRevealDurationProvider durationMs={settings.revealDurationMs}><AgentQueueProvider key={generation}><AgentSteeringProvider><AgentDraftProvider persistence={draftPersistence}><WritingFileRuntimeProvider key={generation}>
    <NativeCanvasHost key={generation} preview={preview} generation={generation} fixture={state.fixture} onReady={setHostReady} outputIntervalMs={Math.round(settings.pacing.intervalMs)}
      sceneNavigationRevision={sceneNavigationRevision}
      documentsClosing={documentsClosing} ownerDrained={state.ownerDrained} admissionsBlocked={documentsClosing||state.disposing} registerDocumentClose={registerDocumentClose}
      controls={controls} adapter={adapter} busy={state.busy||!adapter.available()}/>
  </WritingFileRuntimeProvider></AgentDraftProvider></AgentSteeringProvider></AgentQueueProvider></StreamRevealDurationProvider>;
}

type NativeCanvasHostProps = {readonly preview:NativeAgentPreview;readonly generation:string;
  readonly sceneNavigationRevision:number;
  readonly fixture:NativeCanvasFixture|null;readonly onReady:(fixtureId:string)=>void;readonly controls:(children:React.ReactNode)=>React.ReactNode;
  readonly adapter:NativeCanvasScenarioAdapter;readonly busy:boolean;readonly documentsClosing:boolean;readonly ownerDrained:boolean;readonly admissionsBlocked:boolean;
  readonly registerDocumentClose:(prepare:()=>Promise<boolean>)=>()=>void;readonly outputIntervalMs:number};

function NativeCanvasHost(props: NativeCanvasHostProps): React.JSX.Element {
  const initial = props.fixture?.manuscriptId ?? props.preview.bootstrap.manuscriptId;
  const [manuscripts, setManuscripts] = useState([initial]);
  const [active, setActive] = useState(initial);
  const [editorTarget, setEditorTarget] = useState<HTMLDivElement | null>(null);
  const [controlsTarget, setControlsTarget] = useState<HTMLDivElement | null>(null);
  const [independentGateway, setIndependentGateway] = useState(() => agentContextGateway);
  const textDocuments = useTextDocuments("writing");
  const lastFixture = useRef(props.fixture?.fixtureId);
  // Compare explicit user navigation with the scene selection, not a generic
  // busy transition: automatic host restoration must not masquerade as a click.
  const navigationEpoch = useRef(0), sceneEpoch = useRef(0), previousSceneRevision = useRef(props.sceneNavigationRevision);
  useLayoutEffect(() => {
    if (previousSceneRevision.current === props.sceneNavigationRevision) return;
    previousSceneRevision.current = props.sceneNavigationRevision;
    sceneEpoch.current = navigationEpoch.current;
  }, [props.sceneNavigationRevision]);
  useEffect(() => {
    if (props.fixture && lastFixture.current !== props.fixture.fixtureId) {
      lastFixture.current = props.fixture.fixtureId;
      const id=props.fixture.manuscriptId;
      setManuscripts(current => current.includes(id) ? current : [...current, id]);
      // A newer manual selection wins even if fixture creation finishes later.
      if (navigationEpoch.current === sceneEpoch.current) setActive(id);
    }
  }, [props.fixture?.fixtureId, props.fixture?.manuscriptId]);
  return <AgentCanvasPreviewFrame workspaceBlocked={props.admissionsBlocked}
    tabs={<WorkspaceTabBar owner="writing" textActive={textDocuments.activeId!==undefined} navigate={()=>{textDocuments.deactivate();return true;}}/>}
    documents={<div ref={setEditorTarget}/>} controls={<div ref={setControlsTarget}/> }>
    <AgentCanvasShell independent independentGateway={independentGateway} initialMode="writing" placement="contained" navigationRevision={props.sceneNavigationRevision} onNavigationIntent={()=>{navigationEpoch.current+=1;}}>
      {textDocuments.surface}
      {manuscripts.map(manuscriptId => <NativeCanvasWorkspace key={manuscriptId} {...props} manuscriptId={manuscriptId}
        enabled={active===manuscriptId} editorTarget={editorTarget} controlsTarget={controlsTarget} deactivateText={textDocuments.deactivate} textActive={textDocuments.activeId!==undefined} onContextGateway={setIndependentGateway}/>)}
    </AgentCanvasShell>
  </AgentCanvasPreviewFrame>;
}

function NativeCanvasWorkspace({preview,generation,fixture:currentFixture,onReady,controls,adapter,busy,documentsClosing,ownerDrained,admissionsBlocked,registerDocumentClose,outputIntervalMs,manuscriptId,enabled,editorTarget,controlsTarget,deactivateText,textActive,onContextGateway}:NativeCanvasHostProps & {
  readonly manuscriptId:string;readonly enabled:boolean;readonly editorTarget:HTMLElement|null;readonly controlsTarget:HTMLElement|null;readonly deactivateText:()=>void;
  readonly textActive:boolean;
  readonly onContextGateway:(gateway:typeof agentContextGateway)=>void;
}):React.JSX.Element{
  const fixture=currentFixture?.manuscriptId===manuscriptId?currentFixture:null;
  const access=useMemo(()=>({identity:`native-agent-preview:${generation}:${manuscriptId}`,gateway:agentSessionGateway,metadata:agentMetadataGateway,
    selection:{read:(binding:Parameters<typeof readAgentSessionSelection>[0])=>readAgentSessionSelection(binding)??fixture?.conversationId??null,
      write:writeAgentSessionSelection,clear:clearAgentSessionSelection}}),[generation,manuscriptId,fixture?.fixtureId,fixture?.conversationId]);
  const hostVisible=useAgentCanvasHostVisible();
  const history=useWritingAgentHistory(manuscriptId,access,enabled&&hostVisible),owners=useAgentQueueOwners();
  const writing=useMemo(()=>getWritingGateway(),[generation,manuscriptId]);
  const checkpointGateway=useMemo(()=>getWritingCheckpointGateway(),[generation,manuscriptId]);
  const documents=useWritingDocuments({identity:`native-agent-preview:${generation}:${manuscriptId}`,
    manuscriptId,gateway:writing,checkpointGateway,initialOpenPaths:[fixture?.activePath??currentFixture?.activePath??"main.tex"],
    persistWorkspaceSession:false,admissionsBlocked});
  const editorHost=useRef<HTMLElement>(null);
  const [refresh,setRefresh]=useState(0);
  const [contextFaultArmed,setContextFaultArmed]=useState(false),[contextFaultConfiguring,setContextFaultConfiguring]=useState(false),contextFault=useRef(false),contextFaultOwner=useRef(true);
  const [legacyQueueArmed,setLegacyQueueArmed]=useState<false|"running"|"settled">(false),[legacyQueueBusy,setLegacyQueueBusy]=useState(false),legacyQueueFault=useRef<false|"running"|"settled">(false);
  const [taskFaultArmed,setTaskFaultArmed]=useState(false),taskFault=useRef(false);
  const [startObservationFaultArmed,setStartObservationFaultArmed]=useState(false),startObservationFault=useRef(false);
  const [contextToolState,setContextToolState]=useState<"idle"|"configuring"|"list-ready"|"note-ready"|"mcp-ready">("idle");
  const [noteFixtureId,setNoteFixtureId]=useState<string>();
  const [resumeHoldState,setResumeHoldState]=useState<"idle"|"armed"|"committed">("idle"),resumeHoldRelease=useRef<(()=>void)|null>(null);
  useEffect(()=>{contextFaultOwner.current=true;return()=>{contextFaultOwner.current=false;contextFault.current=false;legacyQueueFault.current=false;taskFault.current=false;startObservationFault.current=false;resumeHoldRelease.current?.();resumeHoldRelease.current=null;};},[]);
  const contextGateway=useMemo(()=>nativeContextStartObservationFault(nativeContextTaskFault(nativeContextLegacyQueueFault(nativeContextQueueFault(agentContextGateway,preview,()=>{
    if(!contextFault.current)return false;contextFault.current=false;setContextFaultArmed(false);return true;
  }),preview,()=>{const mode=legacyQueueFault.current;if(!mode)return false;legacyQueueFault.current=false;setLegacyQueueArmed(false);setLegacyQueueBusy(true);return mode;},()=>{if(contextFaultOwner.current)setLegacyQueueBusy(false);}),()=>taskFault.current),()=>startObservationFault.current),[preview]);
  useLayoutEffect(()=>{if(enabled)onContextGateway(contextGateway);},[enabled,contextGateway,onContextGateway]);
  useEffect(()=>{if(fixture)history.setOpen(true);},[generation,manuscriptId,fixture?.fixtureId]);
  useEffect(()=>registerDocumentClose(documents.prepareClose),[registerDocumentClose,documents.prepareClose]);
  useEffect(()=>{if(fixture&&documents.editorReady)onReady(fixture.fixtureId);},[fixture?.fixtureId,documents.editorReady,onReady]);
  const ready=documents.ready&&!admissionsBlocked&&(!!history.pendingConversationId||history.conversation.status==="ready");
  const running=!!history.conversation.projection&&[...history.conversation.projection.turns.values()].some(turn=>turn.outcome===null);
  function refreshed(){void history.refreshMetadata();setRefresh(value=>value+1);}
  const fixtureControls=<>
    <CanvasControlGroup title="启动与任务故障" description="在独立对话中模拟启动回执和任务观察异常。"><div className="agent-canvas-control-row">
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked||!!legacyQueueArmed||legacyQueueBusy}
      onClick={()=>{startObservationFault.current=!startObservationFault.current;setStartObservationFaultArmed(startObservationFault.current);}}>
      {startObservationFaultArmed?"关闭启动身份不可发现模拟":"模拟启动身份不可发现"}</button>
    {startObservationFaultArmed&&<span role="status">仅模拟一次启动回执丢失和原运行身份不可发现；关闭后可核对真实结果。</span>}
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked||!!legacyQueueArmed||legacyQueueBusy}
      onClick={()=>{taskFault.current=!taskFault.current;setTaskFaultArmed(taskFault.current);}}>
      {taskFaultArmed?"关闭合成任务观察故障":"模拟独立任务观察故障"}</button>
    {taskFaultArmed&&<span role="status">仅模拟下一条独立运行完成后的观察故障；关闭模拟后可核对真实回执。</span>}
    </div></CanvasControlGroup>
    <CanvasControlGroup title="资源与工具夹具" description="准备隔离数据，再通过实际对话和上下文控件操作。"><div className="agent-canvas-control-row">
    {fixture&&<NativeCanvasResourceFixtureControl key={`paper:${fixture.fixtureId}`} kind="paper" preview={preview} fixture={fixture} disabled={busy||admissionsBlocked}/>}
    {fixture&&<NativeCanvasResourceFixtureControl key={`note:${fixture.fixtureId}`} kind="note" preview={preview} fixture={fixture} disabled={busy||admissionsBlocked} onPrepared={setNoteFixtureId}/>}
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked||contextFaultArmed||!!legacyQueueArmed||legacyQueueBusy||contextFaultConfiguring||contextToolState==="configuring"}
      onClick={()=>{setContextToolState("configuring");void preview.configure(nativeCanvasSamples("tool", "independent").map((sample,index)=>index===0?{...sample,delayMs:outputIntervalMs}:sample))
        .then(()=>{if(contextFaultOwner.current)setContextToolState("list-ready");})
        .catch(()=>{if(contextFaultOwner.current){setContextToolState("idle");notify.error("独立对话工具场景准备失败，请重试。");}});}}>
      {contextToolState==="configuring"?"正在准备独立工具续轮…":"准备独立工具续轮"}</button>
    {(contextToolState==="list-ready"||contextToolState==="note-ready"||contextToolState==="mcp-ready")&&<span role="status">独立对话的新运行将使用合成{contextToolState==="note-ready"?"笔记读取":contextToolState==="mcp-ready"?"MCP 工具":"工具续轮"}响应；需要重新准备以应用输出间隔。</span>}
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked||contextFaultArmed||!!legacyQueueArmed||legacyQueueBusy||contextFaultConfiguring||contextToolState==="configuring"||!preview.bootstrap.supported.includes("mcp-namespace-fixture")}
      onClick={()=>{setContextToolState("configuring");void (async()=>{const receipt=await preview.invoke("agent_preview_prepare_mcp_fixture",{});
        if(!receipt||typeof receipt!=="object"||!("schemaVersion" in receipt)||receipt.schemaVersion!==1)throw new Error("agent_preview_invalid_mcp_fixture");
        await preview.configure(nativeCanvasMcpSamples().map((sample,index)=>index===0?{...sample,delayMs:outputIntervalMs}:sample));})()
        .then(()=>{if(contextFaultOwner.current)setContextToolState("mcp-ready");})
        .catch((cause:unknown)=>{if(contextFaultOwner.current){setContextToolState("idle");notify.error(agentCanvasPreviewError(cause));}});}}>
      {contextToolState==="configuring"?"正在准备工具场景…":"准备合成 MCP 工具"}</button>
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked||contextFaultArmed||!!legacyQueueArmed||legacyQueueBusy||contextFaultConfiguring||contextToolState==="configuring"||!noteFixtureId}
      onClick={()=>{if(!noteFixtureId)return;setContextToolState("configuring");void preview.configure(nativeCanvasNoteReadSamples(noteFixtureId).map((sample,index)=>index===0?{...sample,delayMs:outputIntervalMs}:sample))
        .then(()=>{if(contextFaultOwner.current)setContextToolState("note-ready");})
        .catch(()=>{if(contextFaultOwner.current){setContextToolState("idle");notify.error("笔记读取场景准备失败，请重试。");}});}}>
      准备独立笔记读取</button>
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked}
      onClick={()=>{flushSync(()=>history.setOpen(false)); history.newConversation(); history.setOpen(true);}}>
      新建稿件对话夹具</button>
    </div></CanvasControlGroup>
    <CanvasControlGroup title="队列与恢复故障" description="设置故障后，使用实际队列和恢复控件核对结果。"><div className="agent-canvas-control-row">
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||!!legacyQueueArmed||legacyQueueBusy||contextFaultConfiguring||contextToolState==="configuring"||!preview.bootstrap.supported.includes("context-queue-admission-fixture")}
      onClick={()=>{if(contextFault.current){contextFault.current=false;setContextFaultArmed(false);return;}
        setContextToolState("idle");setContextFaultConfiguring(true);void preview.configure([0,1,2].map(index=>({...nativeCanvasSamples("text")[0]!,delayMs:index===0?500:20})))
          .then(()=>{if(contextFaultOwner.current){contextFault.current=true;setContextFaultArmed(true);}}).catch(()=>{if(contextFaultOwner.current)notify.error("独立队列故障场景准备失败，请重试。");})
          .finally(()=>{if(contextFaultOwner.current)setContextFaultConfiguring(false);});}}>
      {contextFaultArmed?"取消独立队列接纳中断":"设置独立队列接纳中断"}</button>
    {contextFaultArmed&&<span>请在独立对话发送消息，并在回复期间排队下一条消息。</span>}
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked||legacyQueueBusy||legacyQueueArmed==="running"||contextFaultArmed||taskFaultArmed||startObservationFaultArmed||contextFaultConfiguring||contextToolState==="configuring"||!preview.bootstrap.supported.includes("context-legacy-settlement-fixture")}
      onClick={()=>{if(legacyQueueFault.current){legacyQueueFault.current=false;setLegacyQueueArmed(false);return;}
        setContextToolState("idle");setContextFaultConfiguring(true);void preview.configure([0,1,2].map(index=>({...nativeCanvasSamples("text")[0]!,delayMs:index===0?500:20})))
          .then(()=>{if(contextFaultOwner.current){legacyQueueFault.current="settled";setLegacyQueueArmed("settled");}}).catch(()=>{if(contextFaultOwner.current)notify.error("旧队列恢复场景准备失败，请重试。")})
          .finally(()=>{if(contextFaultOwner.current)setContextFaultConfiguring(false);});}}>
      {legacyQueueArmed==="settled"?"取消旧队列收尾恢复":"设置旧队列收尾恢复"}</button>
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||admissionsBlocked||legacyQueueBusy||legacyQueueArmed==="settled"||contextFaultArmed||taskFaultArmed||startObservationFaultArmed||contextFaultConfiguring||contextToolState==="configuring"||!preview.bootstrap.supported.includes("context-legacy-running-fixture")}
      onClick={()=>{if(legacyQueueFault.current){legacyQueueFault.current=false;setLegacyQueueArmed(false);return;}
        setContextToolState("idle");setContextFaultConfiguring(true);void preview.configure([0,1,2].map(index=>({...nativeCanvasSamples("text")[0]!,delayMs:index===0?500:index===1?1000:20})))
          .then(()=>{if(contextFaultOwner.current){legacyQueueFault.current="running";setLegacyQueueArmed("running");}}).catch((cause:unknown)=>{if(contextFaultOwner.current)notify.error(agentCanvasPreviewError(cause));})
          .finally(()=>{if(contextFaultOwner.current)setContextFaultConfiguring(false);});}}>
      {legacyQueueArmed==="running"?"取消旧队列运行观察":"设置旧队列运行观察"}</button>
    {legacyQueueArmed&&<span role="status">请在独立对话发送消息，并在回复期间排队下一条；{legacyQueueArmed==="running"?"队列回合运行时可核对原请求。":"队列回合完成后可核对原请求。"}</span>}
    {legacyQueueBusy&&<span role="status">正在准备原队列回合的恢复场景。</span>}
    <button className="agent-canvas-demo-reset" type="button" disabled={busy||!preview.holdNextContextResume}
      onClick={()=>{if(resumeHoldRelease.current){resumeHoldRelease.current();resumeHoldRelease.current=null;setResumeHoldState("idle");return;}
        try{resumeHoldRelease.current=preview.holdNextContextResume!(()=>{if(contextFaultOwner.current)setResumeHoldState("committed");});setResumeHoldState("armed");}
        catch{notify.error("队列恢复回执故障准备失败，请重试。");}}}>
      {resumeHoldState==="idle"?"暂停独立队列恢复回执":"释放独立队列恢复回执"}</button>
    {resumeHoldState==="committed"&&<span role="status">独立队列恢复已提交，回执已暂停；可重启隔离后端验证恢复。</span>}
    </div></CanvasControlGroup>
    {(fixture?.scenario.startsWith("submission")||fixture?.scenario.startsWith("metadata")||fixture?.scenario==="internalRunning")&&<CanvasControlGroup title="场景操作" description="按当前场景继续模拟。"><div className="agent-canvas-control-row">
    {fixture?.scenario.startsWith("submission")&&<span>请在输入框输入消息并发送，以触发所选状态。</span>}
    {fixture?.scenario==="internalRunning"&&<span>点击对话列表左上角的机器人查看内部对话；停止生成后可预览空闲状态。</span>}
    {(fixture?.scenario==="submissionPreparing"||fixture?.scenario==="submissionCheckingFailed")&&<button className="agent-canvas-demo-reset" type="button" disabled={busy||!history.selectedId||!!history.pendingConversationId} onClick={()=>{if(history.selectedId&&!history.pendingConversationId)void adapter.releaseSubmission(history.selectedId);}}>{fixture.scenario==="submissionCheckingFailed"?"模拟核对失败":"继续模拟发送"}</button>}
    {fixture?.scenario.startsWith("metadata")&&<button className="agent-canvas-demo-reset" type="button" disabled={busy||!history.selectedId||!!history.pendingConversationId} onClick={()=>{if(history.selectedId&&!history.pendingConversationId)void adapter.releaseMetadata(history.selectedId).then(ok=>{if(ok)void history.refreshMetadata();});}}>完成模拟核对</button>}
    </div></CanvasControlGroup>}
    <CanvasControlGroup title="错误注入" description="队列、删除、补充说明和断连在此设置；发送、工具、断流和压缩错误在消息场景中选择。结果和恢复界面使用实际运行路径。">
    {!history.selectedId&&<div className="agent-canvas-control-row">选择一个对话后，可设置队列、删除和网络故障。</div>}
    {history.selectedId&&owners&&<AgentCanvasQueueErrors key={history.selectedId} registry={owners.writing} scope={{manuscriptId,conversationId:history.selectedId}}
      faults={{setNextEditFailure:failure=>adapter.fault({type:"queueFault",failure},history.selectedId!)}} ready={!!fixture&&!busy&&ready&&!history.isArchived}/>}
    {history.selectedId&&<AgentCanvasDeletionErrors key={`deletion:${history.selectedId}`}
      faults={{setNextDeletionFailure:failure=>adapter.fault({type:"deletionFault",failure},history.selectedId!)}}
      available={preview.bootstrap.supported.includes(NATIVE_CANVAS_DELETION_FAULTS_CAPABILITY)} ready={!!fixture&&!busy&&!admissionsBlocked&&history.isArchived}/>}
    {history.selectedId&&<AgentCanvasRecovery key={`recovery:${fixture?.fixtureId??"existing"}`} faults={{setSteerFailure:failure=>adapter.fault({type:"steerFault",failure},history.selectedId!),disconnect:mode=>adapter.fault({type:"disconnect",mode},history.selectedId!)}}
      active={!!fixture&&!busy&&ready&&running&&!history.isArchived} onSimulate={()=>history.setOpen(true)}/>}
    </CanvasControlGroup>
    {preview.bootstrap.pending.length>0&&<p className="agent-canvas-demo-status">待接入：{preview.bootstrap.pending.join("、")}</p>}
  </>;
  const jumpToEditor=(path:string)=>{deactivateText();void documents.select(path);
    requestAnimationFrame(()=>editorHost.current?.scrollIntoView({block:"start",behavior:"smooth"}));};
  return <>
    {editorTarget && createPortal(<div hidden={!enabled} inert={!enabled || (ownerDrained && !!fixture)}><NativeCanvasEditor manuscriptId={manuscriptId} documents={documents} blocked={documentsClosing||busy||(ownerDrained && !!fixture)}
      active={enabled} tabsActive={!textActive} hostRef={editorHost}/></div>,editorTarget)}
    {controlsTarget && createPortal(<div hidden={!enabled} inert={!enabled}>{controls(fixtureControls)}</div>,controlsTarget)}
    <AgentCanvasHost enabled={enabled} workspaceId={manuscriptId} selectedId={history.selectedId} onSelect={history.select} onArchive={history.setArchived} onDeleted={history.deleted}
      open={history.isOpen} onOpenChange={history.setOpen} onNewConversation={history.newConversation}
      conversations={<BoundConversationList binding={{kind:"manuscript",resourceId:manuscriptId}} selectedId={history.selectedId} pendingConversationId={history.pendingConversationId} onCreate={history.newConversation}
        onSelect={history.select} onArchiveChange={history.setArchived} onDeleted={history.deleted} onRefreshSelected={()=>void history.refreshMetadata()} refreshToken={refresh} revealConversation={history.revealedConversation} metadata={agentMetadataGateway}/> }>
      {hostControls=><WritingAgentRuntimePanel {...hostControls} manuscriptId={manuscriptId} conversationId={history.selectedId} pendingConversationId={history.pendingConversationId}
        onConversationCreationFinished={history.newConversation} onConversationCreated={conversation=>{history.conversationCreated(conversation);refreshed();}} onConversationTitleChanged={refreshed}
        open={history.isOpen} onOpenChange={history.setOpen} onOpenConversation={history.openRelatedConversation} searchTarget={history.searchTarget} conversationTitle={history.metadata.conversation?.title}
        activePath={documents.activePath} content={documents.content} contentHash={documents.contentHash} files={documents.fileList}
        readEditorSnapshot={documents.readEditorSnapshot} readFileBuffers={()=>readWritingSubmissionBuffers(manuscriptId,documents.files,writing)}
        undoProposal={documents.undoProposal} onSubmissionAdmitted={documents.agentDelivery.register} fileDeliveries={documents.agentDelivery.entries}
        fileSessions={documents.files} onJumpToEditor={jumpToEditor}
        messages={history.messages} projection={history.conversation.projection} historyReady={ready} historyError={!history.pendingConversationId&&history.conversation.status==="error"} archived={history.isArchived}
        {...(documents.loadFailure ? {hostFailure:{content:documents.loadFailure.retryable ? "读取稿件失败，原对话与文件已保留。" : "无法核对稿件恢复状态，原对话与文件已保留。", diagnosticText:JSON.stringify({manuscriptId,...diagnosticError(documents.loadFailure.cause)}), ...(documents.loadFailure.retryable ? {retry:documents.retryLoad} : {})}} : {})}
        metadataLoading={!history.pendingConversationId&&history.metadata.status==="loading"} metadataUnavailable={history.pendingConversationId?undefined:history.metadata.unavailableReason}
        onRetryMetadata={()=>void history.refreshMetadata()} dismissOnOutsideClick={false}/>}
    </AgentCanvasHost>
  </>;
}
