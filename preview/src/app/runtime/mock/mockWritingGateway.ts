import { bibliographyFixture } from "./bibliographyFixture";
import { parseManuscriptPath, type CompileRun } from "@research-assistant/writing";
import { createBrowserWritingGateway } from "../../../../../src/features/writing/gateway/browserWritingGateway";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";

import {readSamplePdf} from "@research-assistant/workbench-preview/preview-assets";
export {readSamplePdf, SAMPLE_PDF_URL} from "@research-assistant/workbench-preview/preview-assets";
export function createMockWritingGateway(storage: Storage, bibliographyPreview = false): WritingGateway {
  const base = createBrowserWritingGateway(storage,bibliographyPreview ? {initialBibliography:bibliographyFixture} : {});
  const runs = decodeMockState<Map<string, CompileRun>>(storage.getItem("compile-runs") ?? encodeMockState(new Map()));
  const persist = () => storage.setItem("compile-runs", encodeMockState(runs));
  const run = (id: string) => { const value = runs.get(id); if (!value) throw new Error("模拟编译记录不存在"); return value; };
  const latest = (id: string) => [...runs.values()].filter(value => value.manuscriptId === id).at(-1);
  return {
    ...base, supportsCompilation: true,
    previewImport: async () => ({ fileCount: 1, byteSize: 128, rootCandidates: [parseManuscriptPath("main.tex")] }),
    importProject: async (title, _sourcePath, rootPath) => { const manuscript = await base.createManuscript({ title, rootPath }); return { manuscript, fileCount: 1, rootCandidates: [parseManuscriptPath(rootPath)] }; },
    detectToolchain: async () => ({ available: true, tools: [{ name: "模拟 latexmk", available: true, version: "preview-v1" }], supportedEngines: ["pdflatex", "xelatex", "lualatex"], checkedAt: new Date().toISOString() }),
    startCompile: async (manuscriptId, engine) => {
      await base.syncBibliography(manuscriptId, []);
      await base.listFiles(manuscriptId);
      const value: CompileRun = { id: crypto.randomUUID(), manuscriptId, engine, status: "succeeded", diagnostics: [], artifacts: [{ kind: "pdf", byteSize: (await readSamplePdf()).length }], rawOutput: "模拟编译成功；产物为静态 PDF 样本。", exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
      runs.set(value.id, value); persist();
      // The production controller polls a started job before consuming its PDF.
      const { finishedAt: _finished, exitCode: _exit, ...started } = value;
      return { ...started, status: "queued", artifacts: [] };
    },
    getCompileRun: async id => run(id), getLatestCompileRun: async id => latest(id), getLatestPdfCompileRun: async id => latest(id),
    isCompileCurrent: async id => run(id).status === "succeeded",
    cancelCompile: async id => { runs.set(id, { ...run(id), status: "cancelled" }); persist(); },
    readCompilePdf: async id => { run(id); return readSamplePdf(); },
    forwardSynctex: async id => { run(id); return [{ page: 1, x: 60, y: 62, width: 300, height: 20 }]; },
    inverseSynctex: async id => { const value = run(id); const file = (await base.listManuscripts()).find(item => item.id === value.manuscriptId); return [{ relativePath: file?.rootPath ?? "main.tex", line: 1, column: 1 }]; },
    exportSource: async (manuscriptId, destinationPath) => { await base.listFiles(manuscriptId); return { destinationPath, warnings: [], fileCount: 1, byteSize: 128 }; },
    exportPdf: async (manuscriptId, destinationPath) => { if (!latest(manuscriptId)) throw new Error("请先模拟编译"); return { destinationPath, warnings: [], fileCount: 1, byteSize: 128 }; },
    importResources: async (manuscriptId, destinationDirectory) => {
      const relativePath = parseManuscriptPath(`${destinationDirectory ? destinationDirectory + "/" : ""}preview-resource.tex`);
      await base.createFile(manuscriptId, relativePath, "% 模拟导入资源\n");
      return { importedPaths: [relativePath], byteSize: 128, warnings: [] };
    },
  };
}
