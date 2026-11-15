import type { AgentApplicationScope, AgentApplicationState } from "@research-assistant/core/agent";
import type { createAgentApplicationGateway } from "@research-assistant/data/agent";
import type { EditorApplicationResult, createWritingEditorApplication } from "../editor/editorApplication";
import type { WritingApplicationLease } from "./writingProposalApplication";

/** Recovery observes a prior intent; it never retries the original application. */
export async function recoverWritingApplication(
  scope: AgentApplicationScope,
  path: string,
  gateway: Pick<ReturnType<typeof createAgentApplicationGateway>, "execute">,
  editor: ReturnType<typeof createWritingEditorApplication>,
  acquire: (scope: AgentApplicationScope) => Promise<WritingApplicationLease | null>,
): Promise<EditorApplicationResult> {
  const lease = await acquire(scope);
  if (!lease) return {kind:"unavailable"};
  let known: AgentApplicationState | null = null;
  let result: EditorApplicationResult = {kind:"unavailable"};
  async function reconcile(current: WritingApplicationLease): Promise<EditorApplicationResult> {
    const response = await gateway.execute({action:"read",scope});
    if (response.kind !== "state") return {kind:"unconfirmed",state:null};
    known = response;
    const file = response.files.find(item => item.path === path);
    if (!file || !current.isCurrent()) return {kind:"unavailable"};
    if (file.phase !== "dispatched") return {kind:"state",state:response};
    if (file.target.kind === "disk") {
      // An originally closed disk target may now have a live buffer. Do not
      // reconcile its disk baseline underneath that editing session.
      if (current.buffers.some(buffer => buffer.path === path)) return {kind:"unavailable"};
      const reconciled = await gateway.execute({action:"reconcileDisk",scope,path});
      return reconciled.kind === "state" ? {kind:"state",state:reconciled} : {kind:"unconfirmed",state:known};
    }
    return editor.recover(scope,path);
  }
  try {result = await reconcile(lease);}
  catch {result = {kind:"unconfirmed",state:known};}
  finally {
    try {await lease.refresh();}
    catch {result = {kind:"unconfirmed",state:"state" in result ? result.state : known};}
    finally {lease.release();}
  }
  return result;
}
