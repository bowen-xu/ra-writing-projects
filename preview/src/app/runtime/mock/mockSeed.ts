import type { LiteratureItem } from "@research-assistant/core/literature";
import { noteBlockId } from "@research-assistant/core/notes";
import { parseManuscriptPath } from "@research-assistant/writing";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import { initialChanges } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import { getNotesGateway } from "@research-assistant/workbench-preview/gateways-gateway";
import {readSamplePdf} from "@research-assistant/workbench-preview/preview-assets";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
import { seedPreviewLiterature } from "@research-assistant/literature-library-preview";
import { seedNalMockData } from "@research-assistant/literature-library-preview";

export const PREVIEW_PAPER_ID = "10000000-0000-4000-8000-000000000001";
export const PREVIEW_ATTACHMENT_ID = "10000000-0000-4000-8000-000000000002";
export const PREVIEW_PROJECT_ID = "10000000-0000-4000-8000-000000000003";

async function seedInitialMockData(storage: Storage, writing: WritingGateway): Promise<void> {
  if (storage.getItem("seeded") === "1") return;
  const pdf = await readSamplePdf(), timestamp = "2026-10-09T00:00:00.000Z";
  const item: LiteratureItem = {
    id: PREVIEW_PAPER_ID, itemType: "journalArticle", title: "Synthetic Research Preview: Evidence and Autonomy", abstractText: "合成文献，用于验证阅读、批注、笔记与写作的数据关联。", issuedYear: 2026,
    containerTitle: "Preview Journal", volume: "1", issue: "1", pages: "1", doi: "", url: "", language: "en", bibtexKey: "preview2026", sourceKind: "user",
    creators: [{ familyName: "Preview", givenName: "Researcher", literalName: "", role: "author" }], tags: ["预览"], readingStatus: "reading",
    attachments: [{ id: PREVIEW_ATTACHMENT_ID, displayName: "sample.pdf", mimeType: "application/pdf", byteSize: pdf.length, contentSha256: await writingDiffDemoHash(pdf) }], projectIds: [PREVIEW_PROJECT_ID],
    metadataSources: [{ fieldName: "title", sourceKind: "user", confirmedByUser: true }], createdAt: timestamp, updatedAt: timestamp,
  };
  storage.setItem("research-assistant.literature.v1", JSON.stringify([item, { ...item, id: crypto.randomUUID(), title: "Mock Methods and Reproducibility", attachments: [], readingStatus: "unread" }]));
  storage.setItem("research-assistant.projects.v1", JSON.stringify([{ id: PREVIEW_PROJECT_ID, title: "合成研究项目", summary: "预览专用，无真实研究数据", createdAt: timestamp, literatureCount: 1, evidenceCount: 0 }]));
  const notes = getNotesGateway(), page = await notes.createPage({ title: "研究计划（合成笔记）" });
  await notes.saveDocument({ expectedRevision: 0, saveReason: "manual", document: { ...page.document, blocks: [{
    id: noteBlockId(crypto.randomUUID()), type: "paragraph", props: {}, children: [],
    content: { kind: "inline", items: [{ type: "text", text: "研究计划：阅读合成文献，记录证据，并更新 Autonomy 稿件。", styles: [] }] },
  }] } });
  await getNotesGateway().createReadingNote({ itemId: PREVIEW_PAPER_ID, attachmentId: PREVIEW_ATTACHMENT_ID, pageIndex: 0, rects: [{ x: 0.09, y: 0.04, width: 0.6, height: 0.03 }], quoteExact: "Synthetic Research Preview", body: "这是一条合成批注。", color: "yellow", noteType: "highlight" });
  const manuscript = await writing.createManuscript({ title: "Autonomy（合成稿件）", rootPath: "main.tex" });
  for (const change of initialChanges) {
    if (change.kind === "added") continue;
    const existing = (await writing.listFiles(manuscript.id)).find(file => file.relativePath === change.path);
    if (existing) await writing.saveFile({ manuscriptId: manuscript.id, relativePath: parseManuscriptPath(change.path), content: change.before, expectedSha256: existing.sha256 });
    else await writing.createFile(manuscript.id, change.path, change.before);
  }
  storage.setItem("initial-manuscript", manuscript.id);
  storage.setItem("seeded", "1");
}

export async function seedMockData(storage: Storage, writing: WritingGateway): Promise<void> {
  await seedInitialMockData(storage, writing);
  seedPreviewLiterature(storage);
  await seedNalMockData(storage,PREVIEW_PAPER_ID);
}
