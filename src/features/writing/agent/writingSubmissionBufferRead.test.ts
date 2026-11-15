/** @vitest-environment happy-dom */
import { expect, it } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { readWritingSubmissionBuffers } from "./writingSubmissionSources";

it("freezes observed disk equal to D after a lost receipt without changing S, B or the original session", async () => {
  const files = new WritingFileSessions();
  const file = files.open({ manuscriptId: "m", relativePath: "main.tex" }, "original", "old-sha");
  file.applyAgent("operation", file.read().version, "agent text");
  const before = file.read();
  const result = await readWritingSubmissionBuffers("m", files, { readFile: async () => ({
    relativePath: parseManuscriptPath("main.tex"), content: "agent text", sha256: "actual-sha",
  }) });
  expect(result[0]).toMatchObject({ text: "agent text", expectedDiskSha256: "actual-sha" });
  expect(file.savedSha256).toBe("old-sha");
  expect(file.read()).toEqual(before);
  expect(file.pending).toBe(true);
});
it("rejects unrelated external bytes and a document edited during disclosure capture", async () => {
  const files = new WritingFileSessions();
  const file = files.open({ manuscriptId: "m", relativePath: "main.tex" }, "original", "old-sha");
  await expect(readWritingSubmissionBuffers("m", files, { readFile: async () => ({
    relativePath: parseManuscriptPath("main.tex"), content: "outside", sha256: "other-sha",
  }) })).rejects.toThrow("外部修改");
  await expect(readWritingSubmissionBuffers("m", files, { readFile: async () => {
    file.dispatch({ changes: { from: 0, insert: "typed " } });
    return { relativePath: parseManuscriptPath("main.tex"), content: "original", sha256: "old-sha" };
  } })).rejects.toThrow("正在变化");
});
