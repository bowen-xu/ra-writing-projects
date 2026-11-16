import { noteBlockId, type NoteBlockV1, type NoteInlineBlockContentV1 } from "@research-assistant/core/notes";

function text(value: string): NoteInlineBlockContentV1 { return { kind: "inline", items: [{ type: "text", text: value, styles: [] }] }; }
function block(id: string, type: NoteBlockV1["type"], content: NoteBlockV1["content"], props: NoteBlockV1["props"] = {}): NoteBlockV1 {
  return { id: noteBlockId(id), type, props, content, children: [] };
}
/** Named synthetic inputs/outputs exercise the real production rich editor.
 * Stable separator headings keep each format's review independently resolvable. */
export function mockNoteFormatFixture(): readonly NoteBlockV1[] {
  return [
    block("preview-format-section", "heading", text("多种格式示例"), { level: 1 }),
    block("preview-format-heading", "heading", text("实验指标"), { level: 2 }),
    block("preview-format-inline-label", "paragraph", text("行内样式与公式")),
    block("preview-format-inline", "paragraph", { kind: "inline", items: [
      { type: "text", text: "能量模型：", styles: ["bold"] }, { type: "inlineFormula", source: "E = mc^2" },
      { type: "text", text: "；这些数值仅用于界面预览。", styles: ["italic"] },
    ] }),
    block("preview-format-equation-label", "paragraph", text("块级公式")),
    block("preview-format-equation", "formulaBlock", { kind: "formula", source: "f(x) = x^2" }),
    block("preview-format-table-label", "paragraph", text("表格")),
    block("preview-format-table", "table", { kind: "table", rows: [[text("条件"), text("示例准确率")], [text("无噪声"), text("0.80")], [text("有噪声"), text("0.65")]] }),
    block("preview-format-quote-label", "paragraph", text("引用与列表")),
    block("preview-format-quote", "quote", text("先明确假设，再检查证据。")),
    block("preview-format-list-anchor", "paragraph", text("验证步骤")),
    block("preview-format-list", "checkListItem", text("比较噪声条件"), { checked: false }),
    block("preview-format-code-label", "paragraph", text("代码")),
    block("preview-format-code", "codeBlock", text("score = evaluate(model)\nprint(score)"), { language: "python" }),
  ];
}
export function reviseMockNoteFormats(blocks: readonly NoteBlockV1[]): NoteBlockV1[] {
  let changed = false;
  const result = blocks.map(original => {
    let next = original;
    if (original.id === "preview-format-heading") next = { ...original, props: { ...original.props, level: 3 }, content: text("实验指标与稳健性验证") };
    if (original.id === "preview-format-inline") next = { ...original, content: { kind: "inline", items: [
      { type: "text", text: "修订能量模型：", styles: ["bold", "underline"] }, { type: "inlineFormula", source: "E^2 = (mc^2)^2 + (pc)^2" },
      { type: "text", text: "；保留普通链接和对象引用。", styles: ["italic"] },
    ] } };
    if (original.id === "preview-format-equation") next = { ...original, content: { kind: "formula", source: "f(x) = x^2 + \\lambda x" } };
    if (original.id === "preview-format-table" && original.content.kind === "table") next = { ...original, content: { kind: "table", rows:
      original.content.rows.map((row, index) => index === 2 ? [row[0]!, text("0.72（模拟）")] : row) } };
    if (original.id === "preview-format-quote") next = { ...original, content: text("先明确可检验的假设，再检查证据和反例。") };
    if (original.id === "preview-format-list") next = { ...original, props: { ...original.props, checked: true }, content: text("比较噪声与遮挡条件") };
    if (original.id === "preview-format-code") next = { ...original, content: text("score = evaluate(model, noise=True)\nprint(round(score, 3))") };
    if (JSON.stringify(next) !== JSON.stringify(original)) changed = true;
    return next;
  });
  if (!changed) throw new Error("格式示例已包含这些修改，请逐处审阅或重置后再次尝试。");
  return result;
}
