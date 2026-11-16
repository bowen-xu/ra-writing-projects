import { parseManuscriptPath, type WritingSession } from "@research-assistant/writing";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import type { WritingDiffDemoStorage } from "../../../../agent/WritingDiffDemoStorage";

/** Replace external I/O while retaining production persistence and application hooks. */
export function createWritingDiffDemoGateway(storage: WritingDiffDemoStorage, manuscriptId: string): WritingGateway {
  let session: WritingSession | undefined;
  const unsupported = async (): Promise<never> => { throw new Error("此操作不在写作 Diff 模拟稿件的范围内"); };
  return {
    rekeyCitations: async (_id,assignments) => ({assignments,files:[],checkpoints:[]}),
    updateBibliographyEntry: async () => { throw new Error("演示稿件没有参考文献"); },
    listBibliographyEntries: async () => [],
    removeUnusedImportedBibliographyEntries: async () => 0,
    linkBibliographyEntry: async () => { throw new Error("此演示没有参考文献条目"); },
    ...storage.files,
    listManuscripts: async () => [{ id: manuscriptId, title: "Autonomy", rootPath: parseManuscriptPath("demo"),
      status: "active", createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" }],
    listDirectories: async () => [{ relativePath: parseManuscriptPath("sections") }, { relativePath: parseManuscriptPath("figures") }],
    listCitationBindings: async () => [],
    getBibliographyStatus: async () => ({ relativePath: parseManuscriptPath("references.bib"), status: "ready", warnings: [] }),
    saveSession: async (draft) => {
      if (draft.manuscriptId !== manuscriptId) throw new Error("模拟写作会话身份不匹配");
      session = { ...structuredClone(draft), updatedAt: "2026-10-07T00:00:00Z" };
    },
    getSession: async (id) => {
      if (id !== manuscriptId) throw new Error("模拟写作会话身份不匹配");
      return session ? structuredClone(session) : undefined;
    },
    listRecoveryDrafts: async () => [],
    supportsCompilation: false,
    createManuscript: unsupported, archiveManuscript: unsupported, deleteManuscript: unsupported,
    restoreManuscript: unsupported, updateManuscript: unsupported, renameFile: unsupported, deleteFile: unsupported,
    createDirectory: unsupported, renameDirectory: unsupported, deleteDirectory: unsupported, importResources: unsupported,
    saveRecoveryDraft: unsupported, previewImport: unsupported, importProject: unsupported, exportSource: unsupported,
    exportPdf: unsupported, forwardSynctex: unsupported, inverseSynctex: unsupported, detectToolchain: unsupported,
    startCompile: unsupported, getCompileRun: unsupported, getLatestCompileRun: unsupported, getLatestPdfCompileRun: unsupported,
    isCompileCurrent: unsupported, cancelCompile: unsupported, readCompilePdf: unsupported, searchCitations: unsupported,
    bindCitation: unsupported, syncBibliography: unsupported, regenerateBibliography: unsupported, preserveBibliographyEdits: unsupported,
  };
}
