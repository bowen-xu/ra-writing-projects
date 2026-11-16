import {decodeAgentContextQueueEditRequest, decodeAgentQueueCommand, decodeAgentQueueState, type AgentQueueState, type AgentContextPreview, type AgentContextQueueConfirmation} from "@research-assistant/core/agent";
import type {AgentQueueGateway} from "@research-assistant/data/agent";
import {decodeMockState, encodeMockState} from "@research-assistant/workbench-preview/mock-state-codec";

/** Mock SQLite I/O only. Production hooks own scheduling, retry and presentation. */
export class MockConversationQueue {
  private records = new Map<string, AgentQueueState>();
  private receipts = new Map<string, {request:string;result:AgentQueueState}>();
  private admitted = new Map<string, AgentContextQueueConfirmation>();
  constructor(private readonly storage: Storage, private readonly authorize: (id:string)=>Promise<void>, private readonly epoch?: string) {
    const saved = storage.getItem("independent-queues");
    if (saved) {
      const state = decodeMockState(saved) as {records:Map<string,AgentQueueState>;receipts:Map<string,{request:string;result:AgentQueueState}>;admitted:Map<string,AgentContextQueueConfirmation>};
      this.records = new Map([...state.records].map(([id,queue])=>[id,decodeAgentQueueState({...queue,paused:true,revision:queue.revision+1})]));
      this.receipts=state.receipts;this.admitted=state.admitted;
      this.save();
    }
  }
  private save(): void {this.storage.setItem("independent-queues",encodeMockState({records:this.records,receipts:this.receipts,admitted:this.admitted}));}
  read(id:string): AgentQueueState {return structuredClone(this.records.get(id) ?? {schemaVersion:1,conversationId:id,revision:0,paused:false,preparingInputId:null,inputs:[]});}
  private put(queue:AgentQueueState): AgentQueueState {const next=decodeAgentQueueState(queue);this.records.set(next.conversationId,next);this.save();return structuredClone(next);}
  readonly gateway: AgentQueueGateway<{conversationId:string},AgentQueueState> = {
    read: async scope => {await this.authorize(scope.conversationId);return this.read(scope.conversationId);},
    edit: async request => {
      await this.authorize(request.conversationId);
      const guarded=decodeAgentContextQueueEditRequest(request);
      if(guarded.expectedEpoch && guarded.expectedEpoch!==this.epoch)throw {code:"conflict"};
      const command=decodeAgentQueueCommand({requestId:request.requestId,expectedRevision:request.expectedRevision,edit:request.edit});
      const serialized=JSON.stringify({...command,conversationId:request.conversationId,
        ...(guarded.expectedEpoch ? {expectedEpoch:guarded.expectedEpoch} : {})}), prior=this.receipts.get(request.requestId);
      if (prior) {if(prior.request!==serialized)throw {code:"conflict"};return structuredClone(prior.result);}
      const current=this.read(request.conversationId), edit=command.edit;
      if(current.revision!==command.expectedRevision||current.preparingInputId)throw {code:"conflict"};
      let inputs=[...current.inputs],paused=current.paused;
      if(edit.type==="add") {
        if(inputs.some(input=>input.inputId===edit.inputId)||[...this.admitted.values()].some(value=>value.inputId===edit.inputId))throw {code:"conflict"};
        inputs.push({inputId:edit.inputId,text:edit.text,userInput:edit.userInput??[]});
      } else if(edit.type==="update") {
        if(!inputs.some(input=>input.inputId===edit.inputId))throw {code:"conflict"};
        inputs=inputs.map(input=>input.inputId===edit.inputId?{...input,text:edit.text,userInput:edit.userInput??[]}:input);
      } else if(edit.type==="remove") {
        if(!inputs.some(input=>input.inputId===edit.inputId))throw {code:"conflict"};
        inputs=inputs.filter(input=>input.inputId!==edit.inputId);
      }
      else if(edit.type==="reorder") {
        if(edit.inputIds.length!==inputs.length||new Set(edit.inputIds).size!==inputs.length||edit.inputIds.some(id=>!inputs.some(input=>input.inputId===id)))throw {code:"conflict"};
        inputs=edit.inputIds.map(id=>inputs.find(input=>input.inputId===id)!);
      } else if(edit.type==="pause"||edit.type==="resume") paused=edit.type==="pause";
      else if(edit.type==="pauseInput"||edit.type==="resumeInput") {
        if(!inputs.some(input=>input.inputId===edit.inputId))throw {code:"conflict"};
        if(paused&&edit.type==="resumeInput") {inputs=inputs.map(input=>({...input,paused:true}));paused=false;}
        inputs=inputs.map(input=>input.inputId===edit.inputId?{...input,paused:edit.type==="pauseInput"}:input);
      } else throw {code:"invalid"};
      const result=this.put({...current,revision:current.revision+1,inputs,paused});
      this.receipts.set(request.requestId,{request:serialized,result});this.save();return result;
    },
  };
  claim(preview:AgentContextPreview,confirmation:AgentContextQueueConfirmation):AgentContextQueueConfirmation {
    const queue=this.read(preview.conversationId),head=queue.inputs.find(input=>!input.paused);
    if(queue.paused||queue.preparingInputId||queue.revision!==confirmation.expectedRevision||head?.inputId!==confirmation.inputId||head.text!==preview.input.text||JSON.stringify(head.userInput??[])!==JSON.stringify(preview.input.userInput??[]))throw "confirmationMismatch";
    const next=this.put({...queue,revision:queue.revision+1,preparingInputId:head.inputId});
    return {inputId:head.inputId,expectedRevision:next.revision};
  }
  confirmation(preview:AgentContextPreview):AgentContextQueueConfirmation|undefined {
    if(!preview.queue)return undefined;
    const prior=this.admitted.get(preview.requestId);
    if(prior)return prior;
    const state=this.read(preview.conversationId);
    if(state.preparingInputId!==preview.queue.inputId)throw "confirmationMismatch";
    return {...preview.queue,expectedRevision:state.revision};
  }
  isAdmitted(preview: AgentContextPreview): boolean {
    const saved = this.admitted.get(preview.requestId);
    return !!preview.queue && !!saved && JSON.stringify(saved) === JSON.stringify(preview.queue);
  }
  admit(preview:AgentContextPreview,resume=false):void {
    if(!preview.queue)return;
    const previous=this.admitted.get(preview.requestId);
    if(previous) {if(JSON.stringify(previous)!==JSON.stringify(preview.queue))throw "confirmationMismatch";return;}
    const state=this.read(preview.conversationId);
    if(state.paused&&!resume||state.preparingInputId!==preview.queue.inputId||state.revision!==preview.queue.expectedRevision)throw "confirmationMismatch";
    this.admitted.set(preview.requestId,preview.queue);
    this.put({...state,paused:resume?false:state.paused,revision:state.revision+1+(resume&&state.paused?1:0),preparingInputId:null,inputs:state.inputs.filter(input=>input.inputId!==preview.queue!.inputId)});
  }
  /** Mirror the native TurnStarted authority check, not the old admission snapshot. */
  requireStartable(preview:AgentContextPreview):void {
    if(preview.queue && this.read(preview.conversationId).paused) throw "confirmationMismatch";
  }
  pause(id:string):void {const state=this.read(id);if(!state.paused)this.put({...state,paused:true,revision:state.revision+1});}
}
