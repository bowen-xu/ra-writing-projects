import type { NoteBlockV1, NoteDocumentV1 } from "@research-assistant/core/notes";
import { NotesGatewayError, type NoteConflictResolutionReceipt } from "@research-assistant/data/notes";
import type { PreviewControls } from "@research-assistant/workbench-preview/app-runtime";
import type { NotePreviewScenarios } from "@research-assistant/workbench-preview/note-preview-scenarios";
import type { MockNoteTextSession } from "./MockNoteTextSession";
import { TEXT_PATCH_PREVIEW_PAGE, type MockTextPatchGateway } from "./mockTextPatchGateway";

function branch(document: NoteDocumentV1, label: string): NoteDocumentV1 {
  let paragraph = false, quote = false;
  const walk = (blocks: readonly NoteBlockV1[]): readonly NoteBlockV1[] => blocks.map(block => {
    if (!paragraph && block.type === "paragraph" && block.content.kind === "inline") {
      paragraph = true;
      return { ...block, content: { ...block.content, items: block.content.items.map((item, index, items) => item.type === "text" && index === items.length - 1 ? { ...item, text: `${item.text}（${label}）` } : item) } };
    }
    if (!quote && block.type === "quote" && block.content.kind === "inline") {
      quote = true;
      return { ...block, content: { ...block.content, items: block.content.items.map((item, index, items) => item.type === "text" && index === items.length - 1 ? { ...item, text: `${item.text}（${label}）` } : item) } };
    }
    return { ...block, children: walk(block.children) };
  });
  return { ...document, blocks: walk(document.blocks) };
}

/** Faults replace external side effects only. No scenario assigns product UI
 * state, renders alternate controls, or bypasses the production CAS failure. */
export function createMockNoteScenarios(session: MockNoteTextSession, textPatch: MockTextPatchGateway, controls: PreviewControls) {
  let resolutionFault: "before" | "after" | undefined;
  const scenarios: NotePreviewScenarios = { run: async scenario => {
    if (scenario === "open") { window.dispatchEvent(new CustomEvent("research-assistant:open-note-page", { detail: TEXT_PATCH_PREVIEW_PAGE })); return; }
    if (scenario === "save-failure") { controls.configure({ delayMs: controls.delayMs, nextFailure: "save" }); return; }
    if (scenario === "resolution-failure" || scenario === "resolution-unknown") {
      resolutionFault = scenario === "resolution-failure" ? "before" : "after"; return;
    }
    if (scenario === "reopen") { session.preserveForReopen(); window.location.reload(); return; }
    if (scenario === "stale-proposal") {
      await textPatch.prepare();textPatch.simulateStaleProposal();
      window.dispatchEvent(new CustomEvent("research-assistant:open-note-page", { detail: TEXT_PATCH_PREVIEW_PAGE }));return;
    }
    if (scenario === "ai-write") {
      const previous = { delayMs: controls.delayMs, nextFailure: controls.nextFailure };
      controls.configure({ delayMs: 3000, nextFailure: null });
      try { await textPatch.simulate("formats"); } finally { controls.configure(previous); }
      return;
    }
    if (scenario === "review-conflict") await textPatch.simulate("rewrite");
    const saved = await session.conflict(document => ({ current: branch(document, "当前编辑分支"), saved: branch(document, "已保存分支") }));
    textPatch.edit(saved.document);
  } };
  return { scenarios, resolve: async (apply: () => Promise<NoteConflictResolutionReceipt>) => {
    const fault = resolutionFault; resolutionFault = undefined;
    if (fault === "before") throw new NotesGatewayError("storage_error", "模拟冲突保存失败：事务未写入。可重新选择并重试。");
    const result = await apply();
    if (fault === "after") throw new NotesGatewayError("operation_unknown", "模拟回执丢失：原请求可能已保存。请重试上次消解。");
    return result;
  } };
}
