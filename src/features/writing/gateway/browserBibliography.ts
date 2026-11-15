import { exportLiterature, parseBibtex } from "@research-assistant/core/citation";
import { createStableCitationKey, isValidCitationKey, parseManuscriptPath, retainedBibliographyKeys, type BibliographyEntryInput, type CitationBinding, type ManuscriptFileContent, type ProjectBibliographyEntry } from "@research-assistant/writing";
import {getOptionalLiteratureGateway} from "@research-assistant/workbench-sdk/domain-capabilities";
const getLiteratureGateway = () => {const port = getOptionalLiteratureGateway(); if (!port) throw new Error("literature_citations_unavailable：文献插件未装配；原引用和稿内书目已保留。"); return port;};
import { matchBibliographyItem } from "../citations/bibliographyManagement";
import type { WritingGateway } from "./writingGateway";
import { browserCitationRekey, rewriteBibtexKey } from "./browserCitationRekey";

type Methods = "rekeyCitations" | "listBibliographyEntries" | "removeUnusedImportedBibliographyEntries" | "linkBibliographyEntry" | "updateBibliographyEntry" | "searchCitations" | "listCitationBindings" | "bindCitation" | "syncBibliography" | "getBibliographyStatus" | "regenerateBibliography" | "preserveBibliographyEdits";
interface FilePort {
  /** Filter headers before loading content. Omitted kind is for explicit rekey. */
  list(id: string, kind?: "tex" | "bib"): readonly ManuscriptFileContent[] | Promise<readonly ManuscriptFileContent[]>;
  stat(id: string, path: string): {readonly sha256: string} | undefined | Promise<{readonly sha256: string} | undefined>;
  write(id: string, path: string, content: string): Promise<void>;
}
export function matchesBibliographyFile(path: string, kind?: "tex" | "bib"): boolean {
  return kind === "tex" ? /\.tex$/iu.test(path) : kind === "bib" ? /\.bib$/iu.test(path) : /\.(?:tex|bib)$/iu.test(path);
}
function bindingsMatch(current: readonly CitationBinding[], inputs: readonly BibliographyEntryInput[]): boolean {
  if (current.length !== inputs.length) return false;
  return inputs.every((input,index) => {
    const previous = current[index];
    if (!previous || previous.literatureItemId !== input.literatureItemId || previous.state !== "active") return false;
    try {
      const draft = parseBibtex(input.bibtexEntry)[0];
      return draft !== undefined && previous.bibtexEntry === exportLiterature([{...draft,bibtexKey:previous.citationKey}],"bibtex");
    } catch {
      // This is only a no-op proof. Keep the original sequential mutation/error
      // path, including applied prefixes, when validation cannot prove equality.
      return false;
    }
  });
}
/** Browser persistence adapter. Only this owner can write managed projections.
 * The desktop import parser remains the lossless native BibTeX boundary.
 */
export function createBrowserBibliography(storage: Storage | undefined, files: FilePort): Pick<WritingGateway, Methods> {
  const rows = new Map<string, ProjectBibliographyEntry[]>(JSON.parse(storage?.getItem("project-bibliography") ?? "[]") as [string, ProjectBibliographyEntry[]][]);
  const bindings = new Map<string, CitationBinding[]>(JSON.parse(storage?.getItem("citation-bindings") ?? "[]") as [string, CitationBinding[]][]);
  const bases = new Map<string, string>(JSON.parse(storage?.getItem("citation-key-bases") ?? "[]"));
  const initialized = new Set(rows.keys());
  const list = (id: string) => rows.get(id) ?? [];
  const bound = (id: string) => bindings.get(id) ?? [];
  const retained = async (id: string, preserveImported = true) => retainedBibliographyKeys((await files.list(id,"tex")).filter(file => /\.tex$/iu.test(file.relativePath)).map(file => file.content), bound(id), list(id), preserveImported);
  function persist(): void {
    storage?.setItem("project-bibliography", JSON.stringify([...rows]));
    storage?.setItem("citation-bindings", JSON.stringify([...bindings]));
  }
  async function adopt(id: string): Promise<void> {
    if (initialized.has(id)) return;
    const capability = getOptionalLiteratureGateway();
    const library = capability ? await capability.list() : undefined;
    if (initialized.has(id)) return;
    const entries: ProjectBibliographyEntry[] = [];
    const occupied = new Set(bound(id).map(row => row.citationKey));
    for (const file of (await files.list(id,"bib")).filter(file => /\.bib$/iu.test(file.relativePath))) {
      for (const draft of parseBibtex(file.content)) {
        // Existing generated bindings already own these keys.
        if (bound(id).some(row => row.citationKey === draft.bibtexKey)) continue;
        // Adopt legacy spelling before the ID-owned migration rewrites source
        // and checkpoints together. Lowercasing only the row would strand cites.
        const key = draft.bibtexKey;
        if (!isValidCitationKey(key) || occupied.has(key)) throw new Error("引用键需要迁移，请使用桌面项目导入规范化；原内容已保留。");
        occupied.add(key);
        const libraryItem = library ? matchBibliographyItem(draft,library) ?? null : null;
        const current = libraryItem ?? draft;
        entries.push({id:crypto.randomUUID(),manuscriptId:id,citationKey:key,originalKey:draft.bibtexKey,
          imported:draft,current,...(libraryItem?{libraryItemId:libraryItem.id}:{}),libraryItem,paths:[file.relativePath],originalBibtex:file.content,
          bibtexEntry:exportLiterature([{...current,bibtexKey:key}],"bibtex")});
      }
    }
    rows.set(id,entries); initialized.add(id); persist();
  }
  async function status(id: string) {
    const file = await files.stat(id,"references.bib");
    return {relativePath:parseManuscriptPath("references.bib"),...(file ? {contentHash:file.sha256}:{}),status:"ready" as const,warnings:[]};
  }
  async function project(id: string): Promise<void> {
    const paths = new Set(list(id).flatMap(row => row.paths));
    if (bound(id).length) paths.add(parseManuscriptPath("references.bib"));
    if (!paths.size) return;
    // Ordinary projection keeps every imported row. Source usage can only
    // affect automatic bindings; explicit import cleanup still reads it afresh.
    const activeKeys = bound(id).length ? await retained(id) : new Set<string>();
    for (const path of paths) {
      const imported = list(id).filter(row => row.paths.includes(path)).map(row => row.bibtexEntry);
      const keys = new Set(list(id).map(row => row.citationKey));
      const added = path === "references.bib" ? bound(id).filter(row => !keys.has(row.citationKey) && activeKeys.has(row.citationKey)).map(row => row.bibtexEntry) : [];
      await files.write(id,path,`% Managed by Research Assistant.\n${[...imported,...added].join("\n\n")}\n`);
    }
  }
  async function refresh(id: string) {
    await adopt(id);
    const next = await Promise.all(list(id).map(async row => {
      const sourceId = row.libraryItemId ?? row.libraryItem?.id;
      if (!sourceId || !getOptionalLiteratureGateway()) return row;
      const item = await getLiteratureGateway().get(sourceId);
      return {...row,libraryItemId:item.id,libraryItem:item,current:item,bibtexEntry:exportLiterature([{...item,bibtexKey:row.citationKey}],"bibtex")};
    }));
    rows.set(id,next); persist(); await project(id); return status(id);
  }
  const methods: Pick<WritingGateway,Methods> = {
    rekeyCitations: async (id, assignments) => {
      await adopt(id);
      const all = await methods.listBibliographyEntries(id, true);
      for (const assignment of assignments) {
        const row = all.find(row => row.id === assignment.referenceId);
        if (!row || row.citationKey !== assignment.from) throw new Error("引用已变化，请重新核对");
      }
      const mapping = new Map(assignments.map(row => [row.from,row.to]));
      return browserCitationRekey(id, assignments, {
        files: () => files.list(id), write: async (path,content) => {await files.write(id,path,content);await project(id);},
        commit: () => {
          rows.set(id,list(id).map(row => ({...row,citationKey:mapping.get(row.citationKey) ?? row.citationKey,bibtexEntry:rewriteBibtexKey(row.bibtexEntry,mapping)})));
          bindings.set(id,bound(id).map(row => ({...row,citationKey:mapping.get(row.citationKey) ?? row.citationKey,bibtexEntry:rewriteBibtexKey(row.bibtexEntry,mapping)})));
          for (const row of assignments) bases.set(`${id}:${row.referenceId}`,row.baseKey);
          storage?.setItem("citation-key-bases",JSON.stringify([...bases]));persist();
        },
      }).then(async result => {await project(id);return result;});
    },
    removeUnusedImportedBibliographyEntries: async id => {
      await adopt(id);
      const used = await retained(id, false), previous = list(id);
      const next = previous.filter(row => used.has(row.citationKey));
      // Publish empty former import paths too. Manuscript cleanup never changes
      // the global literature library.
      rows.set(id, next); persist();
      for (const path of new Set(previous.flatMap(row => row.paths))) {
        if (!next.some(row => row.paths.includes(path))) await files.write(id, path, "% Managed by Research Assistant.\n");
      }
      await project(id); return previous.length - next.length;
    },
    listBibliographyEntries: async (id, includeUnusedAutomatic = false) => {
      await adopt(id);
      const imported=await Promise.all(list(id).map(async row => ({...row,libraryItem:(row.libraryItemId ?? row.libraryItem?.id) && getOptionalLiteratureGateway() ? await getLiteratureGateway().get((row.libraryItemId ?? row.libraryItem?.id)!) : row.libraryItem})));
      const automatic = bound(id).filter(binding => !imported.some(row => row.citationKey === binding.citationKey));
      // All-entry completion and key planning do not depend on source usage.
      // Preserve fresh library metadata without rereading every .tex document.
      const activeKeys = includeUnusedAutomatic || !automatic.length ? undefined : await retained(id);
      const generated=await Promise.all(automatic.filter(binding=>includeUnusedAutomatic || activeKeys?.has(binding.citationKey)).map(async binding=>{
        const draft=parseBibtex(binding.bibtexEntry)[0];if(!draft)throw new Error("无效的引用条目");
        return {id:`binding:${binding.literatureItemId}`,manuscriptId:id,citationKey:binding.citationKey,originalKey:binding.citationKey,originalBibtex:binding.bibtexEntry,bibtexEntry:binding.bibtexEntry,imported:draft,current:draft,libraryItemId:binding.literatureItemId,libraryItem:getOptionalLiteratureGateway() ? await getLiteratureGateway().get(binding.literatureItemId) : null,paths:["references.bib"]};
      }));return [...imported,...generated].map(row => ({...row,...(bases.has(`${id}:${row.id}`) ? {baseKey:bases.get(`${id}:${row.id}`)!} : {})}));
    },
    linkBibliographyEntry: async (id,entryId,itemId) => {
      await adopt(id); const item = await getLiteratureGateway().get(itemId);
      if(entryId===`binding:${itemId}`) {
        const binding=bound(id).find(row=>row.literatureItemId===itemId);if(!binding)throw new Error("引用不存在");
        bindings.set(id,bound(id).map(row=>row.literatureItemId===itemId?{...row,bibtexEntry:exportLiterature([{...item,bibtexKey:row.citationKey}],"bibtex")}:row));
        persist();await project(id);return;
      }
      if (!list(id).some(row => row.id === entryId)) throw new Error("参考文献条目不存在");
      rows.set(id,list(id).map(row => row.id === entryId ? {...row,libraryItemId:item.id,libraryItem:item,current:item,bibtexEntry:exportLiterature([{...item,bibtexKey:row.citationKey}],"bibtex")} : row));
      persist(); await project(id);
    },
    updateBibliographyEntry: async (id,entryId,expected,draft) => {
      await adopt(id); const row = list(id).find(row => row.id === entryId);
      if (!row || row.libraryItemId || row.libraryItem || row.bibtexEntry !== expected) throw new Error("参考文献已变化，请重新打开后比较");
      rows.set(id,list(id).map(row => row.id === entryId ? {...row,current:draft,bibtexEntry:exportLiterature([{...draft,bibtexKey:row.citationKey}],"bibtex")} : row));
      persist(); await project(id);
    },
    searchCitations: async (id,query,scope) => {
      await adopt(id);
      const known = new Map(list(id).flatMap(row => (row.libraryItemId ?? row.libraryItem?.id) ? [[(row.libraryItemId ?? row.libraryItem?.id)!,row.citationKey] as const] : []));
      for (const row of bound(id)) known.set(row.literatureItemId,row.citationKey);
      return (await getLiteratureGateway().list()).filter(item => !item.trashedAt
        && (scope === "library" || known.has(item.id))
        && `${item.title} ${item.creators.map(p => `${p.familyName} ${p.givenName} ${p.literalName}`).join(" ")} ${item.issuedYear ?? ""} ${item.containerTitle} ${item.bibtexKey} ${known.get(item.id) ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0,60).map(item => ({literatureItemId:item.id,title:item.title,firstAuthor:item.creators[0]?.familyName || item.creators[0]?.literalName || "",
          ...(item.issuedYear ? {issuedYear:item.issuedYear}:{}),containerTitle:item.containerTitle,importedKey:item.bibtexKey,
          ...(known.has(item.id) ? {citationKey:known.get(item.id)!} : {}),hasPdf:item.attachments.length>0,hasEvidence:false,warnings:[]}));
    },
    listCitationBindings: async id => bound(id),
    bindCitation: async (id,input) => {
      await adopt(id);
      const previous = bound(id).find(row => row.literatureItemId === input.literatureItemId);
      const imported = list(id).find(row => (row.libraryItemId ?? row.libraryItem?.id) === input.literatureItemId);
      const occupied = new Set([...bound(id),...list(id)].map(row => row.citationKey));
      const key = previous?.citationKey ?? imported?.citationKey ?? createStableCitationKey({importedKey:input.requestedKey ?? "",title:"reference"},occupied);
      const draft = parseBibtex(input.bibtexEntry)[0]; if (!draft) throw new Error("无效的参考文献");
      const timestamp = new Date().toISOString();
      const row: CitationBinding = {manuscriptId:id,literatureItemId:input.literatureItemId,citationKey:key,bibtexEntry:exportLiterature([{...draft,bibtexKey:key}],"bibtex"),state:"active",pinnedAt:previous?.pinnedAt ?? timestamp,updatedAt:timestamp};
      bindings.set(id,[...bound(id).filter(value => value.literatureItemId !== input.literatureItemId),row]);persist();await project(id);return row;
    },
    syncBibliography: async (id,inputs) => {
      // A complete, unchanged binding refresh needs only the final projection.
      // Preserve order, pinned keys and timestamps; source usage is still read
      // afresh by refresh(), so removals/undo do not use cached source content.
      if (!bindingsMatch(bound(id),inputs)) for (const input of inputs) await methods.bindCitation(id,input);
      return refresh(id);
    },
    getBibliographyStatus: status, regenerateBibliography:refresh, preserveBibliographyEdits:refresh,
  };
  // Match the native bibliography I/O boundary: an older library refresh must
  // not republish imported rows after the user has explicitly cleaned them.
  let pending: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  }
  return {
    rekeyCitations: (...args) => serialized(() => methods.rekeyCitations(...args)),
    listBibliographyEntries: (...args) => serialized(() => methods.listBibliographyEntries(...args)),
    removeUnusedImportedBibliographyEntries: (...args) => serialized(() => methods.removeUnusedImportedBibliographyEntries(...args)),
    linkBibliographyEntry: (...args) => serialized(() => methods.linkBibliographyEntry(...args)),
    updateBibliographyEntry: (...args) => serialized(() => methods.updateBibliographyEntry(...args)),
    searchCitations: (...args) => serialized(() => methods.searchCitations(...args)),
    listCitationBindings: (...args) => serialized(() => methods.listCitationBindings(...args)),
    bindCitation: (...args) => serialized(() => methods.bindCitation(...args)),
    syncBibliography: (...args) => serialized(() => methods.syncBibliography(...args)),
    getBibliographyStatus: (...args) => serialized(() => methods.getBibliographyStatus(...args)),
    regenerateBibliography: (...args) => serialized(() => methods.regenerateBibliography(...args)),
    preserveBibliographyEdits: (...args) => serialized(() => methods.preserveBibliographyEdits(...args)),
  };
}
