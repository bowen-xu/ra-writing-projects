import { NotesGatewayError, type NotesGateway } from "@research-assistant/data/notes";
import type { NotePageId } from "@research-assistant/core/notes";

export type NoteOpeningScenario = "missing" | "failed" | "loading";
export function readNoteOpeningScenario(search: string): NoteOpeningScenario | undefined {
  const params = new URLSearchParams(search), value = params.get("note-open");
  return params.get("preview") === "notes" && (value === "missing" || value === "failed" || value === "loading") ? value : undefined;
}

/** Only the data read changes; the full App, navigation and note workspace stay real. */
export function mockNoteOpening(gateway: NotesGateway, scenario: NoteOpeningScenario, pageId: NotePageId): NotesGateway {
  let attempted = false;
  return { ...gateway, async loadDocument(id) {
    if (id !== pageId) return gateway.loadDocument(id);
    const first = !attempted; attempted = true;
    if (scenario === "missing") throw new NotesGatewayError("not_found", "NOTE_PREVIEW_MISSING · 模拟笔记不存在。");
    if (scenario === "failed" && first) throw new NotesGatewayError("database_busy", "NOTE_PREVIEW_READ_FAILED · operation=note-open-preview · 模拟读取暂时不可用。");
    if (scenario === "loading" && first) await new Promise(resolve => setTimeout(resolve, 8_000));
    return gateway.loadDocument(id);
  } };
}
