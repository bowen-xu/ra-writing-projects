import { expect, it } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { captureWritingSubmissionSources } from "./writingSubmissionSources";

function options() {
  return { manuscriptId: "m", activePath: "main.tex", content: "current", contentHash: "disk-a", contextScope: "manuscript" as const,
    files: ["main.tex", "other.tex"].map((path) => ({ manuscriptId: "m", relativePath: parseManuscriptPath(path), kind: "tex" as const,
      sha256: "old-list", sizeBytes: 1, modifiedAt: "now" })),
    editor: { documentKey: "m:main.tex", sessionId: "session", revision: "revision", text: "current", selection: { startUtf16: 0, endUtf16: 2 } },
    fileBuffers: [{ path: "main.tex", expectedDiskSha256: "disk-a", sessionId: "session", revision: "revision", text: "current" },
      { path: "other.tex", expectedDiskSha256: "disk-b", sessionId: "other-session", revision: "other-revision", text: "other current" }] };
}
it("preserves selected model context while freezing every live buffer for the complete manuscript execution copy", () => {
  const source = options(), frozen = captureWritingSubmissionSources({ ...source, contextScope: "current-file" });
  source.fileBuffers[0]!.text = "later"; source.editor.selection.endUtf16 = 4;
  expect(frozen.buffers).toHaveLength(2);
  expect(frozen.buffers[0]?.text).toBe("current");
  expect(frozen.contextFiles).toEqual([{ relativePath: "main.tex", expectedDiskSha256: "disk-a",
    buffer: { text: "current", revision: "revision" }, selection: { startUtf16: 0, endUtf16: 2 } }]);
});
it.each(["missing", "session", "revision", "text"])("blocks a mismatched active file buffer (%s) instead of freezing stale text", (mismatch) => {
  const source = options();
  if (mismatch === "missing") source.fileBuffers.shift();
  else if (mismatch === "session") source.fileBuffers[0]!.sessionId = "replaced";
  else if (mismatch === "revision") source.fileBuffers[0]!.revision = "replaced";
  else source.fileBuffers[0]!.text = "replaced";
  expect(() => captureWritingSubmissionSources(source)).toThrow("编辑器内容正在切换");
});
it("uses disk context only for files without a live buffer and rejects duplicate file identities", () => {
  const source = options(); source.fileBuffers.pop();
  expect(captureWritingSubmissionSources(source).contextFiles[1]).toEqual({ relativePath: "other.tex", expectedDiskSha256: "old-list" });
  source.fileBuffers.push({ ...source.fileBuffers[0]! });
  expect(() => captureWritingSubmissionSources(source)).toThrow("身份重复");
});
