import {useCallback} from "react";
import {agentSteeringRecoveryGateway} from "../../../../../../apps/web/src/core/public/agent";
import { AgentSteeringRecovery, type AgentSteeringRecoveryProps } from "../../../../../../apps/web/src/core/public/agentSubmission/AgentSteeringRecovery";
export function WritingSteeringRecovery(props:Omit<AgentSteeringRecoveryProps,"read"|"className">&{readonly conversationId:string;readonly manuscriptId:string}):React.JSX.Element{
  const read=useCallback((turnId:string)=>agentSteeringRecoveryGateway.readWritingRecovery({conversationId:props.conversationId,manuscriptId:props.manuscriptId,turnId}),[props.conversationId,props.manuscriptId]);
  return <AgentSteeringRecovery {...props} read={read} className="writing-agent-submission"/>;
}
