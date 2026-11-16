import type { AgentApplicationScope, AgentApplicationState } from "@research-assistant/core/agent";
import type { DemoChange } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import type { WritingDiffDemoStorage } from "./WritingDiffDemoStorage";
import type { WritingDiffDemoRestorationStorage } from "./WritingDiffDemoRestorationStorage";
import { writingDiffDemoBytes, writingDiffDemoText } from "./WritingDiffDemoBytes";

/** Mock the native discovery receipt proof, shared by apply and inverse apply.
 * Current text and save intents are not evidence of a historical dispatch. */
export async function writingDiffDemoPendingSave(state: AgentApplicationState, original: AgentApplicationScope,
  requestId: string, changes: readonly DemoChange[], checkpoints: WritingDiffDemoStorage["checkpoints"],
  restorations: WritingDiffDemoRestorationStorage): Promise<boolean> {
  if (!["applied", "rolledBack"].includes(state.status)) return false;
  const records = await checkpoints.list(original.manuscriptId);
  const candidate = state.files.some(file => {
    if (file.target.kind !== "editor" || (state.status === "rolledBack" && file.phase !== "restored")) return false;
    const id = state.status === "rolledBack" ? restorations.readIntent(state.scope, file.path)?.id : state.scope.operationId;
    const checkpoint = records.find(row => row.checkpoint.relativePath === file.path)?.checkpoint;
    return checkpoint !== undefined && id !== undefined && checkpoint.editorReceipt?.operationId === id
      && checkpoint.savedVersion < (checkpoint.editorReceipt.stateVersion ?? checkpoint.version);
  });
  if (!candidate) return false;
  let pending = false;
  for (const file of state.files) {
    if (file.target.kind !== "editor" || (state.status === "rolledBack" && file.phase !== "restored")) continue;
    const restoration = state.status === "rolledBack" ? restorations.readIntent(state.scope, file.path) : null;
    if (state.status === "rolledBack" && !restoration) throw new Error("模拟文件操作缺少补偿回执");
    const operationId = restoration?.id ?? state.scope.operationId;
    const checkpoint = records.find(row => row.checkpoint.relativePath === file.path)?.checkpoint, receipt = checkpoint?.editorReceipt;
    if (!checkpoint || !receipt || receipt.operationId !== operationId) continue;
    const change = changes.find(change => change.path === file.path);
    if (!change || receipt.sessionId !== (restoration?.sessionId ?? file.target.sessionId)
      || receipt.revision !== (restoration?.resultRevision ?? file.target.resultRevision)
      || receipt.text !== writingDiffDemoText(writingDiffDemoBytes(change, restoration ? "before" : "after"))
      || ![operationId, original.operationId].every(id => checkpoint.operations.some(source => source.operationId === id
        && source.conversationId === original.conversationId && source.requestId === requestId))) {
      throw new Error("模拟文件操作保存回执不匹配");
    }
    pending ||= checkpoint.savedVersion < (receipt.stateVersion ?? checkpoint.version);
  }
  return pending;
}
