import { downloadDir, join } from "@research-assistant/workbench-sdk/platform";
import type { Manuscript, ManuscriptExportResult } from "@research-assistant/writing";
import type { WritingGateway } from "../gateway";

/** Use the OS download directory, keeping the gateway's atomic no-overwrite rule. */
export async function downloadManuscript(
  gateway: WritingGateway,
  manuscript: Manuscript,
  kind: "source" | "pdf",
): Promise<ManuscriptExportResult> {
  let stem = manuscript.title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .trim().replace(/^\.+|[.\s]+$/gu, "") || "manuscript";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
  // Preserve the project name unless the filesystem's filename byte limit requires truncation.
  const encoder = new TextEncoder();
  while (encoder.encode(stem).byteLength > 200) stem = Array.from(stem).slice(0, -1).join("");
  const extension = kind === "source" ? "zip" : "pdf";
  const destination = await join(await downloadDir(), `${stem}.${extension}`);
  return kind === "source"
    ? gateway.exportSource(manuscript.id, destination)
    : gateway.exportPdf(manuscript.id, destination);
}
