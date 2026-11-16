import {decodeAgentSteeringHandoffIntent,type AgentSteeringHandoffIntent,type AgentSteeringHandoffProof} from "@research-assistant/core/agent";
import {agentSteeringHandoffResolvedId,type AgentSteeringHandoffGateway} from "@research-assistant/data/agent";
import type {WritingDiffDemoHistory} from "@research-assistant/workbench-preview/writing-diff-demo-history";
import type {WritingDiffDemoQueue} from "@research-assistant/workbench-preview/writing-diff-demo-queue";
import type {WritingDiffDemoSubmission} from "./WritingDiffDemoSubmission";

/** Synthetic storage I/O; scheduling and recovery stay in the production owner. */
export function createWritingDemoHandoffGateway(queue:WritingDiffDemoQueue,history:WritingDiffDemoHistory,submission:WritingDiffDemoSubmission,
  manuscriptId:string,authorize:(conversationId:string)=>Promise<void>):AgentSteeringHandoffGateway{
  function validate(value:AgentSteeringHandoffIntent):AgentSteeringHandoffIntent{
    const intent=decodeAgentSteeringHandoffIntent(structuredClone(value));
    if(intent.scope.kind!=="manuscript"||intent.scope.manuscriptId!==manuscriptId)throw {code:"conflict"};
    return intent;
  }
  function proof(intent:AgentSteeringHandoffIntent,epoch:string,family:AgentSteeringHandoffProof["family"],operationId:string,replayed:boolean):AgentSteeringHandoffProof{
    return {schemaVersion:1,operationId,conversationId:intent.conversationId,family,epoch,sqlFence:"0",replayed,result:null};
  }
  async function settle(action:"finish"|"release"|"cancel",value:AgentSteeringHandoffIntent,epoch:string):Promise<AgentSteeringHandoffProof>{
    const intent=validate(value),family=`agent.steering.handoff.${action}` as const;
    const operationId=await agentSteeringHandoffResolvedId(family,intent.operationId);
    await authorize(intent.conversationId);
    const admission=submission.steeringHandoffAdmission(intent);
    const discard=action==="release" && admission==="matching" ? submission.prepareSteeringHandoffDiscard(intent) : undefined;
    const result=queue.settleSteeringHandoff(intent,epoch,action,operationId,history.steeringHandoffHistory(intent),
      admission,history.turnIsTerminal(intent.conversationId,intent.turnId),discard);
    return proof(intent,result.epoch,family,operationId,result.replayed);
  }
  return {
    async read(conversationId,expectedEpoch){
      const items=queue.readSteeringHandoffs(conversationId,expectedEpoch),epoch=queue.handoffDataEpoch();
      return {schemaVersion:1,conversationId,epoch,items:items.map(intent=>({intent,
        proof:proof(intent,epoch,"agent.steering.handoff.prepare",intent.operationId,false),history:history.steeringHandoffHistory(intent)}))};
    },
    async prepare(value){
      const intent=validate(value);await authorize(intent.conversationId);
      const result=queue.claimSteeringHandoff(intent,history.activeTurn(intent.conversationId));
      return proof(intent,result.epoch,"agent.steering.handoff.prepare",intent.operationId,result.replayed);
    },
    async resolution(value,epoch){const intent=validate(value);await authorize(intent.conversationId);return queue.steeringHandoffResolution(intent,epoch);},
    finish:(intent,epoch)=>settle("finish",intent,epoch),release:(intent,epoch)=>settle("release",intent,epoch),
    cancelUnregistered:(intent,epoch)=>settle("cancel",intent,epoch),
  };
}
