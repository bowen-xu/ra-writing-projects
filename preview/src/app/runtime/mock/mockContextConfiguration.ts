import { decodeAgentContextState } from "@research-assistant/core/agent";
import type { AgentContextConfiguration,AgentContextGateway } from "@research-assistant/workbench-preview/agent-context-gateway";
/** Replace only persistence and notifications; context ownership uses the production hook. */
export function createMockContextConfiguration(storage:Storage): Pick<AgentContextGateway,"readConfiguration"|"saveConfiguration"|"subscribeConfiguration"> {
  const key=(id:string)=>`mock:context-configuration:${id}`;
  return {
    readConfiguration:async id=>{const raw=storage.getItem(key(id));if(raw===null)return null;const saved=JSON.parse(raw) as AgentContextConfiguration;return {revision:saved.revision,state:decodeAgentContextState(saved.state)};},
    saveConfiguration:async(id,expectedRevision,state)=>{const raw=storage.getItem(key(id));const previous=raw===null?null:JSON.parse(raw) as AgentContextConfiguration;if((previous?.revision??0)!==expectedRevision)throw new Error("confirmationMismatch");const next={revision:expectedRevision+1,state:decodeAgentContextState(state)};storage.setItem(key(id),JSON.stringify(next));return next;},
    subscribeConfiguration:async()=>()=>undefined,
  };
}
