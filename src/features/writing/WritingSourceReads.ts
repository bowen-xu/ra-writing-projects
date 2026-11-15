import {citationKeysInSource, indexLatexSource, type ManuscriptFile} from "@research-assistant/writing";
import type {WritingGateway} from "./gateway";

export interface ParsedWritingSource {
  readonly source: string;
  readonly index: ReturnType<typeof indexLatexSource>;
  readonly citationKeys: readonly string[];
}
const parse = (source: string): ParsedWritingSource => ({source, index: indexLatexSource(source), citationKeys: citationKeysInSource(source)});

/** One workbench, 128 committed files plus one live buffer. Hashes never identify D. */
export class WritingSourceReads {
  private readonly entries = new Map<string, {hash: string; value: Promise<ParsedWritingSource>}>();
  private buffer: {key: string; value: ParsedWritingSource} | undefined;
  constructor(private readonly gateway: Pick<WritingGateway, "readFile">) {}
  live(project: string, path: string, source: string): ParsedWritingSource {
    const key = JSON.stringify([project, path]);
    if (this.buffer?.key === key && this.buffer.value.source === source) return this.buffer.value;
    const value = parse(source); this.buffer = {key, value}; return value;
  }
  committed(project: string, file: ManuscriptFile): Promise<ParsedWritingSource> {
    const key = JSON.stringify([project, file.relativePath]), found = this.entries.get(key);
    if (found?.hash === file.sha256) {
      this.entries.delete(key); this.entries.set(key, found); return found.value;
    }
    const entry = {hash: file.sha256, value: this.gateway.readFile(project, file.relativePath).then(result => {
      // A concurrent external write must not be cached under an old metadata hash.
      if (result.sha256 !== file.sha256 && this.entries.get(key) === entry) this.entries.delete(key);
      return parse(result.content);
    }).catch(reason => {if (this.entries.get(key) === entry) this.entries.delete(key); throw reason;})};
    this.entries.set(key, entry);
    if (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value!);
    return entry.value;
  }
  prune(project: string, files: readonly ManuscriptFile[]): void {
    const retained = new Set(files.map(file => JSON.stringify([project, file.relativePath])));
    for (const key of this.entries.keys()) if (JSON.parse(key)[0] === project && !retained.has(key)) this.entries.delete(key);
  }
}
