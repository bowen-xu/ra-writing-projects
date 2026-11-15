import { useAgentSteeringOwners } from "@research-assistant/workbench-sdk/agent-submission";
import type {AgentConversationProjection,AgentWritingSteerRequest} from "@research-assistant/core/agent";
import {agentSteeringGateway} from "@research-assistant/workbench-sdk/agent-gateways";
import { useAgentSteering, type AgentSteeringSubmitCallbacks } from "@research-assistant/workbench-sdk/agent-submission";
import type {WritingSteeringAccess} from "./writingRuntimeGateways";
import {useWritingRuntimeAdmission} from "../persistence/writingRuntimeAdmission";
type Scope=Omit<AgentWritingSteerRequest,"inputId"|"text">;
const send=(request:AgentWritingSteerRequest)=>agentSteeringGateway.steerWriting(request);
export function useWritingSteering(scope:Scope|null,accepted:(text:string)=>void,projection:AgentConversationProjection|null=null,host?:{readonly key:string;readonly conversationId:string;readonly queueRejected?:import("@research-assistant/workbench-sdk/agent-submission").AgentSteeringSubmitCallbacks["queueRejected"];readonly captureAcknowledgment:(text:string)=>()=>void},access?:WritingSteeringAccess,historyGate?:{readonly isReady:()=>boolean;readonly state:unknown}){
  const owners=useAgentSteeringOwners();
  const {isDisabled}=useWritingRuntimeAdmission();
  const registry=access?.registry??owners?.writing;
  return useAgentSteering(scope,scope?`${scope.conversationId}/${scope.manuscriptId}/${scope.turnId}`:"",access?.send??send,accepted,projection,registry&&host?{registry,hostKey:host.key,conversationId:host.conversationId,captureAcknowledgment:host.captureAcknowledgment,...(host.queueRejected?{queueRejected:host.queueRejected}:{})}:undefined,historyGate,isDisabled);
}
export type {AgentSteeringSubmitCallbacks};
