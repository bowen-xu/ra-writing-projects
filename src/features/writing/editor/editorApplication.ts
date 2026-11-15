import type { AgentApplicationScope, AgentApplicationState, AgentEditorEdit, AgentEditorEditResult, AgentEditorObservation, AgentEditorSessionPort, AgentEditorSnapshot } from "@research-assistant/core/agent";
import type { createAgentApplicationGateway } from "@research-assistant/data/agent";

type Gateway = Pick<ReturnType<typeof createAgentApplicationGateway>, "execute">;
export interface WritingEditorDelivery {
  apply(scope: AgentApplicationScope, path: string, port: AgentEditorSessionPort, edit: AgentEditorEdit): Promise<AgentEditorEditResult>;
  /** A historical receipt may be confirmed only after its file checkpoint is reliable. */
  settle(scope: AgentApplicationScope, path: string, port: AgentEditorSessionPort): Promise<boolean>;
}
export type EditorApplicationResult =
  | { readonly kind: "state"; readonly state: AgentApplicationState }
  | { readonly kind: "busy" | "unavailable" }
  | { readonly kind: "unconfirmed"; readonly state: AgentApplicationState | null };
function observation(path: string, snapshot: AgentEditorSnapshot): AgentEditorObservation {
  return {path,sessionId:snapshot.sessionId,revision:snapshot.revision,text:snapshot.text};
}

/** One coordinator per writing host. Full-plan admission and save coordination
 * belong to that host. resolve must return the target file's current session port;
 * a port captured before awaiting native work must never retarget another file.
 */
export function createWritingEditorApplication(gateway: Gateway, resolve: (scope: AgentApplicationScope, path: string) => AgentEditorSessionPort | null, delivery?: WritingEditorDelivery) {
  let busy=false;
  async function defer(scope: AgentApplicationScope, path: string): Promise<EditorApplicationResult> {
    try {
      const response=await gateway.execute({action:"deferEditor",scope,path});
      return {kind:"unconfirmed",state:response.kind==="state" ? response : null};
    } catch { return {kind:"unconfirmed",state:null}; }
  }
  async function confirm(scope: AgentApplicationScope, path: string, port: AgentEditorSessionPort): Promise<EditorApplicationResult> {
    const receipt=port.readReceipt(scope.operationId);
    if(!receipt || receipt.operationId!==scope.operationId || receipt.snapshot.documentKey!==`${scope.manuscriptId}:${path}`) return defer(scope,path);
    try {
      if (delivery && !await delivery.settle(scope, path, port)) return defer(scope,path);
      if (resolve(scope,path) !== port) return defer(scope,path);
      const response=await gateway.execute({action:"confirmEditor",scope,actual:observation(path,receipt.snapshot)});
      return response.kind==="state" ? {kind:"state",state:response} : defer(scope,path);
    } catch { return defer(scope,path); }
  }
  async function run(value: AgentApplicationScope, path: string, mode: "apply" | "recover"): Promise<EditorApplicationResult> {
    if(busy) return {kind:"busy"};
    busy=true;
    const scope={...value};
    try {
      const port=resolve(scope,path), current=port?.read();
      const key=`${scope.manuscriptId}:${path}`;
      if(mode==="apply" && (!port || current?.documentKey!==key)) return {kind:"unavailable"};
      const response=await gateway.execute(mode==="apply" && current
        ? {action:"prepareEditor",scope,current:observation(path,current)} : {action:"read",scope});
      if(response.kind==="state") {
        const file=response.files.find(f=>f.path===path);
        if(file?.phase!=="dispatched") return {kind:"state",state:response};
        if(!port || resolve(scope,path)!==port || port.read()?.documentKey!==key) return await defer(scope,path);
        return await confirm(scope,path,port);
      }
      if(mode!=="apply" || !port || resolve(scope,path)!==port || port.read()?.documentKey!==key) return await defer(scope,path);
      const edit = {operationId:scope.operationId,text:response.text,expected:{documentKey:key,
        sessionId:response.expected.sessionId,revision:response.expected.revision,text:response.expected.text}};
      const result=delivery ? await delivery.apply(scope,path,port,edit) : port.apply(edit);
      // Unconfirmed dispatch is reconciled by an explicit later recovery, not a replay.
      if(result.status!=="applied") return await defer(scope,path);
      return await confirm(scope,path,port);
    } catch { return await defer(scope,path); }
    finally { busy=false; }
  }
  return {
    apply(scope: AgentApplicationScope,path: string) { return run(scope,path,"apply"); },
    recover(scope: AgentApplicationScope,path: string) { return run(scope,path,"recover"); },
  };
}
