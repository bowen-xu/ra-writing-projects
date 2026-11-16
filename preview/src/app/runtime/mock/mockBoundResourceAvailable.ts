import type { AgentConversationBinding } from "@research-assistant/core/agent";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import type { LiteratureGateway } from "@research-assistant/literature-library-preview";
import { browserNoteHostExists } from "@research-assistant/workbench-preview/browser-notes-storage";

/** Mock only the resource data; creation and receipt recovery use shared contracts. */
export function createMockBoundResourceReader(writing: Pick<WritingGateway, "listManuscripts">,
  literature: Pick<LiteratureGateway, "get">,
  noteExists: typeof browserNoteHostExists = browserNoteHostExists) {
  return async (binding: AgentConversationBinding): Promise<boolean> => {
    if (binding.kind === "manuscript") return (await writing.listManuscripts()).some(row => row.id === binding.resourceId);
    if (binding.kind === "note" || binding.kind === "readingNote") return noteExists(binding.kind, binding.resourceId);
    try { await literature.get(binding.resourceId); return true; }
    catch (reason) {
      // This browser metadata adapter's absence error is stable; retain other failures.
      if (reason instanceof Error && reason.message === "找不到文献") return false;
      throw reason;
    }
  };
}
