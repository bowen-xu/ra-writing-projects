import type { WritingGateway } from "./writingGateway";

// New gateway methods require classification: anything absent here must have
// an explicit protected adapter below. Recovery metadata remains writable.
type IndependentMethod =
  | "listManuscripts" | "listFiles" | "listDirectories" | "saveSession" | "getSession"
  | "saveRecoveryDraft" | "listRecoveryDrafts" | "clearRecoveryDraft" | "previewImport"
  | "exportPdf" | "forwardSynctex" | "inverseSynctex" | "detectToolchain" | "getCompileRun"
  | "getLatestCompileRun" | "getLatestPdfCompileRun" | "cancelCompile" | "readCompilePdf"
  | "searchCitations" | "listCitationBindings" | "getBibliographyStatus" | "supportsCompilation";
type ProtectedMethod = Exclude<keyof WritingGateway, IndependentMethod>;

/** Per-workspace coordination, not an OS lock. Agent native commands bypass
 * this adapter only while holding the acquired lease and their native journal.
 */
export function createExclusiveWritingGateway(source: WritingGateway) {
  let exclusive = false;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const pending = new Set<Promise<unknown>>();
  function guarded<T>(operation: () => Promise<T>): Promise<T> {
    if (exclusive) return Promise.reject(new Error("正在核对或应用提案，请稍后再操作稿件文件。"));
    // Register before invoking the adapter, including synchronous failures.
    const result = Promise.resolve().then(operation).finally(() => pending.delete(result));
    pending.add(result);
    return result;
  }
  const protectedMethods: Pick<WritingGateway, ProtectedMethod> = {
    duplicateManuscript: (...args) => guarded(() => source.duplicateManuscript ? source.duplicateManuscript(...args) : Promise.reject(new Error("writing_duplicate_unavailable：当前环境不支持复制稿件"))),
    rekeyCitations: (...args) => guarded(() => source.rekeyCitations(...args)),
    createManuscript: (...args) => guarded(() => source.createManuscript(...args)),
    archiveManuscript: (...args) => guarded(() => source.archiveManuscript(...args)),
    deleteManuscript: (...args) => guarded(() => source.deleteManuscript(...args)),
    restoreManuscript: (...args) => guarded(() => source.restoreManuscript(...args)),
    updateManuscript: (...args) => guarded(() => source.updateManuscript(...args)),
    readFile: (...args) => guarded(() => source.readFile(...args)),
    saveFile: (...args) => guarded(() => source.saveFile(...args)),
    createFile: (...args) => guarded(() => source.createFile(...args)),
    renameFile: (...args) => guarded(() => source.renameFile(...args)),
    deleteFile: (...args) => guarded(() => source.deleteFile(...args)),
    createDirectory: (...args) => guarded(() => source.createDirectory(...args)),
    renameDirectory: (...args) => guarded(() => source.renameDirectory(...args)),
    deleteDirectory: (...args) => guarded(() => source.deleteDirectory(...args)),
    importResources: (...args) => guarded(() => source.importResources(...args)),
    importProject: (...args) => guarded(() => source.importProject(...args)),
    exportSource: (...args) => guarded(() => source.exportSource(...args)),
    startCompile: (...args) => guarded(() => source.startCompile(...args)),
    isCompileCurrent: (...args) => guarded(() => source.isCompileCurrent(...args)),
    bindCitation: (...args) => guarded(() => source.bindCitation(...args)),
    listBibliographyEntries: (...args) => guarded(() => source.listBibliographyEntries(...args)),
    removeUnusedImportedBibliographyEntries: (...args) => guarded(() => source.removeUnusedImportedBibliographyEntries(...args)),
    updateBibliographyEntry: (...args) => guarded(() => source.updateBibliographyEntry(...args)),
    linkBibliographyEntry: (...args) => guarded(() => source.linkBibliographyEntry(...args)),
    syncBibliography: (...args) => guarded(() => source.syncBibliography(...args)),
    regenerateBibliography: (...args) => guarded(() => source.regenerateBibliography(...args)),
    preserveBibliographyEdits: (...args) => guarded(() => source.preserveBibliographyEdits(...args)),
  };
  return {
    source,
    gateway: {...source, ...protectedMethods} satisfies WritingGateway,
    isExclusive: () => exclusive,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async acquire(): Promise<() => void> {
      if (exclusive) throw new Error("另一项提案操作正在处理。");
      exclusive = true;
      publish();
      // Native failures are not interpreted as success. The caller still runs
      // fresh preflight/reconciliation after every previously started call ends.
      await Promise.allSettled([...pending]);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        exclusive = false;
        publish();
      };
    },
  };
}
