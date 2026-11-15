import { decodeWritingDocumentCheckpoint, rewriteCitationKeys, isValidCitationKey,
  type CitationKeyAssignment, type ManuscriptFileContent, type WritingCheckpointRecord } from "@research-assistant/writing";
import { getWritingCheckpointGateway } from "./writingCheckpointGateway";
import type { CitationKeyMigration } from "../citations/citationKeyMigration";

/** Browser adapter uses the same source/checkpoint migration boundary as native. */
export async function browserCitationRekey(id: string, assignments: readonly CitationKeyAssignment[], port: {
  files(): readonly ManuscriptFileContent[] | Promise<readonly ManuscriptFileContent[]>;
  write(path: string, content: string): Promise<void>;
  commit(): void;
}): Promise<CitationKeyMigration> {
  const targets = new Set<string>();
  for (const assignment of assignments) {
    if (!isValidCitationKey(assignment.to) || targets.has(assignment.to)) throw new Error("引用键冲突");
    targets.add(assignment.to);
  }
  const mapping = new Map(assignments.filter(row => row.from !== row.to).map(row => [row.from, row.to]));
  const gateway = getWritingCheckpointGateway();
  const records = await gateway.list(id);
  const planned: {previous: WritingCheckpointRecord; next: WritingCheckpointRecord["checkpoint"]}[] = [];
  const files: ManuscriptFileContent[] = [];
  for (const file of (await port.files()).filter(file => /\.tex$/iu.test(file.relativePath))) {
    const content = rewriteCitationKeys(file.content, mapping);
    const previous = records.find(row => row.checkpoint.relativePath === file.relativePath);
    if (previous) {
      const checkpoint = previous.checkpoint;
      if (checkpoint.saveIntent || checkpoint.savedSha256 !== file.sha256 || checkpoint.content !== file.content) throw new Error("引用改名需要最新可靠文件检查点");
      const reviewBaseline = rewriteCitationKeys(checkpoint.reviewBaseline, mapping);
      if (content !== checkpoint.content || reviewBaseline !== checkpoint.reviewBaseline) {
        const version = checkpoint.version + 1;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
        const savedSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        planned.push({previous, next: decodeWritingDocumentCheckpoint({...checkpoint, content, reviewBaseline, version, savedVersion:version, savedSha256})});
      }
    }
    if (content !== file.content) files.push({...file,content});
  }
  // Validation precedes mutation. Browser file/checkpoint stores retain their
  // separate receipts; native owns the durable filesystem redo journal.
  port.commit();
  const checkpoints: WritingCheckpointRecord[] = [];
  for (const {previous,next} of planned) checkpoints.push(await gateway.save({expectedRevision:previous.revision,checkpoint:next}));
  for (const file of files) await port.write(file.relativePath, file.content);
  const current = await port.files();
  return {assignments,files:files.map(file => current.find(row => row.relativePath === file.relativePath)!),checkpoints};
}

/** Called only for a single already parsed entry, retaining its explicit key. */
export function rewriteBibtexKey(text: string, mapping: ReadonlyMap<string, string>): string {
  return text.replace(/(@[A-Za-z]+\s*[{(]\s*)([^\s,]+)(\s*,)/gu, (whole, before: string, key: string, after: string) => mapping.has(key) ? `${before}${mapping.get(key)}${after}` : whole)
    .replace(/\b(crossref|xref|xdata|entryset|related)\s*=\s*\{([^{}]*)\}/giu, (_whole, field: string, values: string) => `${field} = {${values.split(",").map(key => mapping.get(key.trim()) ?? key.trim()).join(",")}}`);
}
