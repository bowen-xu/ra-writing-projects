import {referenceSourcePath} from "@research-assistant/core/source";
import type { NoteDocumentV1, NoteInlineContentV1 } from "@research-assistant/core/notes";

function xml(text: string): string { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function text(value: string): string { return value.replace(/([\\`*_\[\]<>])/gu, "\\$1"); }
function inline(item: NoteInlineContentV1): string {
  if (item.type === "link") return `[${item.content.map(inline).join("")}](${item.href})`;
  if (item.type === "mention") return `<reference kind="${item.targetKind}" target="${xml(referenceSourcePath(item.targetKind, item.targetId))}">${xml(item.content?.map(part => part.text).join("") ?? item.labelSnapshot)}</reference>`;
  if (item.type === "inlineFormula") return `\\(${item.source}\\)`;
  let rendered = text(item.text);
  for (const style of item.styles) {
    const delimiter = style === "bold" ? "**" : style === "italic" ? "*" : style === "strike" ? "~~" : style === "code" ? "`" : undefined;
    rendered = delimiter ? `${delimiter}${rendered}${delimiter}` : `<u>${xml(rendered)}</u>`;
  }
  return rendered;
}

/** Fixture text projection only, not a Markdown/XML parser or native codec.
 * Handles ordinary edits to the seeded paragraphs/headings/links/lists; an
 * unsupported synthetic block stops tool reads rather than discarding data. */
export function renderMockNoteText(document: NoteDocumentV1): string {
  const lines = document.blocks.map(block => {
    if (!block.children.length && block.content.kind === "formula") return `\\[\n${block.content.source}\n\\]`;
    if (!block.children.length && block.content.kind === "table") {
      const rows = block.content.rows.map(row => `| ${row.map(cell => cell.items.map(inline).join("").replaceAll("|", "\\|")).join(" | ")} |`);
      rows.splice(1, 0, `| ${block.content.rows[0]?.map(() => "---").join(" | ")} |`);
      return rows.join("\n");
    }
    if (block.children.length || block.content.kind !== "inline") throw new Error("此模拟只支持示例中的普通文本块；新增特殊块后请用原生应用验证工具读取。");
    const content = block.content.items.map(inline).join("");
    if (block.type === "paragraph") return content;
    if (block.type === "heading") return `${"#".repeat(Number(block.props.level) || 1)} ${content}`;
    if (block.type === "bulletListItem") return `- ${content}`;
    if (block.type === "numberedListItem") return `1. ${content}`;
    if (block.type === "checkListItem") return `- [${block.props.checked ? "x" : " "}] ${content}`;
    if (block.type === "quote") return `> ${content}`;
    if (block.type === "codeBlock") return `\`\`\`${String(block.props.language ?? "")}\n${block.content.items.map(item => item.type === "text" ? item.text : inline(item)).join("")}\n\`\`\``;
    throw new Error("此模拟只支持示例中的普通文本块；新增特殊块后请用原生应用验证工具读取。");
  });
  const list = (index: number) => ["bulletListItem", "numberedListItem", "checkListItem"].includes(document.blocks[index]?.type ?? "");
  const body = lines.reduce((result, line, index) => result + (index ? list(index) && list(index - 1) ? "\n" : "\n\n" : "") + line, "");
  return `---\ntitle: 研究笔记\n---\n\n${body}\n`;
}
