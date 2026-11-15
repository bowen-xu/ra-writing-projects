import type {WritingGateway} from "./gateway";
import type {LiteratureGateway} from "@research-assistant/data/literature";
import {exportLiterature} from "@research-assistant/core/citation";
import type {CitationBinding} from "@research-assistant/writing";

interface BibliographyRead {
  key: string; delivered: boolean; metadataSynced: boolean;
  readonly bindings: readonly CitationBinding[];
  readonly overrides: ReadonlyMap<string, {base: string; saved: string}>;
  readonly value: Promise<{kind: "cancelled"} | {kind: "ready"; status: Awaited<ReturnType<WritingGateway["syncBibliography"]>>; files: Awaited<ReturnType<WritingGateway["listFiles"]>>}>;
  observe(): () => void;
  accept(): void;
}
/** One workbench, latest successful/in-flight source and binding read for 16
 * projects. A metadata reload invalidates its project; visibility does not.
 */
export class WritingBibliographyReads {
  private readonly projects = new Map<string, BibliographyRead>();
  private previous: {project: string; path: string | undefined; hash: string | undefined} | undefined;
  constructor(private readonly gateway: Pick<WritingGateway, "syncBibliography" | "listFiles" | "supportsCompilation">,
    private readonly library: Pick<LiteratureGateway, "get"> | undefined) {}
  invalidate(project: string): void {this.projects.delete(project);}
  ensure(project: string, revision: readonly (readonly [string, string])[], path: string | undefined, hash: string | undefined,
    bindings: readonly CitationBinding[] = []) {
    // A switch changes the visible saved hash without committing a new source.
    // An actual save of the same visible source still triggers reconciliation
    // before the asynchronously refreshed directory metadata catches up.
    const found = this.projects.get(project);
    const metadata = new Map(revision), overrides = new Map(found?.overrides);
    for (const [file, value] of overrides) if (!metadata.has(file) || metadata.get(file) !== value.base && metadata.get(file) !== value.saved) overrides.delete(file);
    const justSaved = this.previous?.project === project && this.previous.path === path && this.previous.hash !== hash;
    if (justSaved && path && hash && metadata.has(path) && metadata.get(path) !== hash) overrides.set(path, {base: metadata.get(path)!, saved: hash});
    this.previous = {project, path, hash};
    const key = JSON.stringify(revision.map(([file, sha]) => [file, overrides.get(file)?.saved ?? sha]).sort(([a], [b]) => a!.localeCompare(b!)));
    if (found?.key === key && (found.bindings === bindings || !found.bindings.length && !bindings.length)) return found.delivered ? undefined : found;
    const metadataSynced = found?.metadataSynced === true && (found.bindings === bindings || !found.bindings.length && !bindings.length);
    let observers = 0;
    const ownsPreparation = () => observers > 0 && this.projects.get(project) === entry;
    const cancelled = () => {if (this.projects.get(project) === entry) this.projects.delete(project);return {kind: "cancelled" as const};};
    const entry: BibliographyRead = {key, overrides, bindings, metadataSynced, delivered: false,
      observe: () => {observers++;let alive = true;return () => {if (alive) {alive = false;observers--;}};},
      accept: () => {entry.delivered = true;},
      value: Promise.resolve().then(async () => {
        if (!ownsPreparation()) return cancelled();
        const inputs = this.library && this.gateway.supportsCompilation && !entry.metadataSynced ? await Promise.all(bindings.map(async binding => {
          const item = await this.library!.get(binding.literatureItemId);
          return {literatureItemId: item.id, requestedKey: binding.citationKey,
            bibtexEntry: exportLiterature([{...item,bibtexKey:binding.citationKey}],"bibtex")};
        })) : [];
        // Leaving or changing the project while library reads are pending must
        // not dispatch an obsolete write. Once dispatched, finish the original
        // operation and metadata receipt; visibility never cancels a save.
        if (!ownsPreparation()) return cancelled();
        const status = await this.gateway.syncBibliography(project,inputs);
        entry.metadataSynced = true;
        return {kind: "ready" as const,status,files: await this.gateway.listFiles(project)};
      }).catch(reason => {if (this.projects.get(project) === entry) this.projects.delete(project);throw reason;})};
    this.projects.delete(project); this.projects.set(project, entry);
    if (this.projects.size > 16) this.projects.delete(this.projects.keys().next().value!);
    return entry;
  }
}
