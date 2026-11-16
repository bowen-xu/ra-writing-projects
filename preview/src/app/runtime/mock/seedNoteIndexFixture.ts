import {readState, writeState} from "@research-assistant/workbench-preview/browser-notes-storage";
import { createNoteDocumentFromText, noteBlockId, notePageId, type NotePage } from "@research-assistant/core/notes";
import { createWritingNote } from "@research-assistant/writing";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import type { NotesGateway } from "@research-assistant/data/notes";
import { PREVIEW_PAPER_ID, PREVIEW_ATTACHMENT_ID } from "./mockSeed";

/** Data only: the app and notes preview exercise the production index and list. */
export async function seedNoteIndexFixture(storage: Storage, writing: WritingGateway, notes: NotesGateway): Promise<void> {
  await seedPagination(storage);
  if (storage.getItem("note-index-fixture-v1")) return;
  const paper = await notes.createLiteratureNote(PREVIEW_PAPER_ID);
  const saved = await notes.saveDocument({ document: createNoteDocumentFromText(paper.page.id, "算法梳理：比较推理过程与实验结果，供跨文献研究使用。", () => noteBlockId(crypto.randomUUID())), expectedRevision: 0, saveReason: "manual" });
  await notes.updatePage({ pageId: saved.page.id, title: "算法梳理（独立文献笔记）", isFavorite: true, expectedRevision: saved.page.revision });
  const sticky = await notes.createReadingNote({ itemId: PREVIEW_PAPER_ID, attachmentId: PREVIEW_ATTACHMENT_ID,
    noteType: "page_note", pageIndex: 0, rects: [], quoteExact: "", body: "阅读想法：这个算法能否推广到其他研究问题？" });
  await notes.updateReadingNote({ id: sticky.id, isFavorite: true, expectedRevision: sticky.revision });
  const manuscript = (await writing.listManuscripts()).find(item => item.status === "active");
  if (manuscript) await writing.createFile(manuscript.id, "notes/行文思路.ranote", JSON.stringify(createWritingNote("preview-writing-outline", "outline", "论文行文思路：问题、算法、实验与结论。")));
  const state = await readState({metadataOnly: true});
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const earlier = new Date(); earlier.setDate(earlier.getDate() - 12);
  await writeState({...state, pages: state.pages.map(page => page.id === sticky.pageId ? {...page, updatedAt: yesterday.toISOString()}
    : page.id === paper.page.id ? {...page, updatedAt: earlier.toISOString()} : page)});
  storage.setItem("note-index-fixture-v1", "1");
}

/** Enough synthetic history to exercise 20 → all → the next streaming page. */
async function seedPagination(storage: Storage): Promise<void> {
  if (storage.getItem("note-index-pagination-v1")) return;
  const state = await readState();
  const subjects = ["研究问题拆解", "算法阅读记录", "实验设计想法", "概念与术语", "论证脉络", "文献对比", "待验证假设", "复现步骤"];
  const pages: NotePage[] = [], documents = {...state.documents};
  for (let index = 0; index < 64; index++) {
    const title = '研究记录 ' + String(index + 1).padStart(2, "0") + ' · ' + subjects[index % subjects.length];
    const id = notePageId(crypto.randomUUID()), date = new Date(); date.setDate(date.getDate() - 2 - Math.floor(index / 8));
    pages.push({id, title, schemaVersion: 1, position: state.pages.length + index, status: "active", isFavorite: false, revision: 1,
      createdAt: date.toISOString(), updatedAt: date.toISOString(), projectIds: [], tagIds: []});
    documents[id] = createNoteDocumentFromText(id, title + '：用于检验统一笔记列表、全局检索和滚动分页的合成记录。', () => noteBlockId(crypto.randomUUID()));
  }
  await writeState({...state, pages: [...state.pages, ...pages], documents});
  storage.setItem("note-index-pagination-v1", "1");
}
