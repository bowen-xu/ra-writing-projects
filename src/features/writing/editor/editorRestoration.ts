import type { AgentApplicationScope, AgentApplicationState, AgentEditorSessionPort, AgentUndoCheckpointVersion } from "@research-assistant/core/agent";
import type { createAgentEditorRestorationGateway } from "@research-assistant/data/agent";
import type { EditorApplicationResult, WritingEditorDelivery } from "./editorApplication";

/** Caller holds the whole manuscript lease (including paused saves). A recovery
 * only reads the durable identity and the matching live port receipt. */
export function createWritingEditorRestoration(
  gateway: ReturnType<typeof createAgentEditorRestorationGateway>,
  resolve: (scope: AgentApplicationScope, path: string) => AgentEditorSessionPort | null,
  delivery?: WritingEditorDelivery,
) {
  let busy=false;
  async function run(value: AgentApplicationScope,path: string,mode: "restore" | "recover", checkpointVersion?: AgentUndoCheckpointVersion): Promise<EditorApplicationResult> {
    if(busy)return {kind:"busy"};
    busy=true;
    const scope={...value},key=`${scope.manuscriptId}:${path}`;
    let state: AgentApplicationState | null=null;
    try {
      const port=resolve(scope,path);
      const initial=await gateway.execute({action:"read",scope,path});
      if(initial.kind!=="state")return {kind:"unconfirmed",state};
      state=initial.application;
      if(initial.restoration?.resultRevision || state.status==="rolledBack")return {kind:"state",state};
      if(!port || resolve(scope,path)!==port || port.read()?.documentKey!==key)return {kind:"unavailable"};
      let restoration=initial.restoration;
      if(!restoration) {
        if(mode==="recover")return {kind:"state",state};
        const current=port.read();
        if(!current || current.documentKey!==key)return {kind:"unavailable"};
        const response=await gateway.execute({action:"prepare",scope,restoreId:crypto.randomUUID(),current:{path,sessionId:current.sessionId,revision:current.revision,text:current.text}, ...(checkpointVersion ? { checkpointVersion } : {})});
        if(response.kind==="state") {
          state=response.application;restoration=response.restoration;
          if(restoration?.resultRevision)return {kind:"state",state};
        } else {
          if(resolve(scope,path)!==port || port.read()?.documentKey!==key)return {kind:"unconfirmed",state};
          const edit={operationId:response.restoreId,expected:{documentKey:key,sessionId:response.expected.sessionId,revision:response.expected.revision,text:response.expected.text},text:response.text};
          const result=delivery ? await delivery.apply({...scope,operationId:response.restoreId},path,port,edit) : port.apply(edit);
          if(result.status!=="applied")return {kind:"unconfirmed",state};
          restoration={id:response.restoreId,sessionId:response.expected.sessionId,expectedRevision:response.expected.revision,resultRevision:null};
        }
      }
      if(!restoration || resolve(scope,path)!==port || port.read()?.documentKey!==key)return {kind:"unconfirmed",state};
      const receipt=port.readReceipt(restoration.id);
      if(!receipt || receipt.operationId!==restoration.id || receipt.snapshot.documentKey!==key
        || receipt.snapshot.sessionId!==restoration.sessionId || receipt.snapshot.revision===restoration.expectedRevision)return {kind:"unconfirmed",state};
      if(delivery && !await delivery.settle({...scope,operationId:restoration.id},path,port))return {kind:"unconfirmed",state};
      if(resolve(scope,path)!==port)return {kind:"unconfirmed",state};
      const confirmed=await gateway.execute({action:"confirm",scope,restoreId:restoration.id,actual:{path,sessionId:receipt.snapshot.sessionId,revision:receipt.snapshot.revision,text:receipt.snapshot.text}});
      return confirmed.kind==="state"?{kind:"state",state:confirmed.application}:{kind:"unconfirmed",state};
    } catch { return {kind:"unconfirmed",state}; }
    finally { busy=false; }
  }
  return {
    restore(scope: AgentApplicationScope,path: string, checkpointVersion?: AgentUndoCheckpointVersion) { return run(scope,path,"restore", checkpointVersion); },
    recover(scope: AgentApplicationScope,path: string) { return run(scope,path,"recover"); },
  };
}
