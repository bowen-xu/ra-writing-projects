import { formatSourceLink } from "@research-assistant/core/source";
import { noteBlockId } from "@research-assistant/core/notes";
import { decodeAgentContextPreview } from "@research-assistant/core/agent";
import type { NotesGateway } from "@research-assistant/data/notes";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import type { MockIndependentAgents } from "./MockIndependentAgents";
import { PREVIEW_PAPER_ID, PREVIEW_ATTACHMENT_ID } from "./mockSeed";

const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const BLOCK_ID = "30000000-0000-4000-8000-000000000002";
export async function seedSourceNavigationFixture(storage: Storage, agents: MockIndependentAgents,
  notes: NotesGateway, writing: WritingGateway): Promise<void> {
  if (!agents.has(CONVERSATION_ID)) {
    const page = await notes.createLiteratureNote(PREVIEW_PAPER_ID);
    await notes.saveDocument({expectedRevision: page.page.revision, saveReason: "manual", document: {...page.document, blocks: [{
      id: noteBlockId(BLOCK_ID), type: "paragraph", props: {}, children: [],
      content: {kind: "inline", items: [{type: "text", text: "这是用于预览来源定位的文献笔记。\n第二行用于测试块内行列定位。", styles: []}]},
    }]}});
    const project = (await writing.listManuscripts()).find(project => project.id === storage.getItem("initial-manuscript"));
    if (!project) throw new Error("来源预览缺少模拟写作项目");
    const line = {startLine: 1, startColumn: 1, endLine: 1, endColumn: 8};
    const pdf = ["library", PREVIEW_PAPER_ID, PREVIEW_ATTACHMENT_ID], note = ["notes", page.page.id];
    const link = (label: string, path: readonly string[], locator?: Parameters<typeof formatSourceLink>[0]["locator"]) => `[${label}](${formatSourceLink({path, ...(locator ? {locator} : {})})})`;
    const response = ["这些是 mock 来源引用，点击后会打开对应的阅读器或编辑器。", "",
      `- 文献：${link("合成文献", ["library", PREVIEW_PAPER_ID])}`,
      `- PDF：${link("第 1 页原文", pdf, {kind: "line", pageNumber: 1, range: line})}`,
      `- 笔记：${link("文献笔记中的块", note, {kind: "block", blockId: BLOCK_ID})}`,
      `- 块内位置：${link("笔记第 2 行", note, {kind: "block", blockId: BLOCK_ID, range: {...line, startLine: 2, endLine: 2}})}`,
      `- 写作项目：${link(project.title, ["writings", project.id])}`,
      `- 写作文件：${link("main.tex 第 1 行", ["writings", project.id, "main.tex"], {kind: "line", range: line})}`,
    ].join("\n");
    const preview = decodeAgentContextPreview({schemaVersion: 1, conversationId: CONVERSATION_ID,
      requestId: crypto.randomUUID(), turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(),
      input: {text: "展示可以点击跳转的来源引用。", model: {providerId: "fixture", modelId: "source-navigation-preview", revision: "1"}, reasoningEffort: null, context: []}});
    await agents.seedConversation(preview, "来源引用预览", response);
  }
  // Only this dedicated, isolated preview selects the fixture on entry.
  storage.setItem("research-assistant:independent-selected", CONVERSATION_ID);
}
