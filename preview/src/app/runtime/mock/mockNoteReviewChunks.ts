import type { NoteDocumentV1 } from "@research-assistant/core/notes";
import type { TextPatchBlockChange } from "@research-assistant/workbench-preview/text-patch-gateway";
import { sameNoteProjection } from "@research-assistant/workbench-preview/note-review-projection";

interface Range { before: number; beforeEnd: number; after: number; afterEnd: number }
function id(value: string): string {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `preview-note-chunk:${(hash >>> 0).toString(16)}`;
}

/** Mirrors native stable-root grouping, including indivisible moved identities.
 * This is synthetic review data; native patch matching still has one owner. */
export function mockNoteReviewChunks(before: NoteDocumentV1, after: NoteDocumentV1): TextPatchBlockChange[] {
  const positions = new Map(after.blocks.map((block, index) => [block.id, index]));
  const ranges: Range[] = [];
  let b = 0, a = 0;
  before.blocks.forEach((block, index) => {
    const target = positions.get(block.id);
    if (target === undefined || target < a || !sameNoteProjection({ ...before, blocks: [block] }, { ...after, blocks: [after.blocks[target]!] })) return;
    if (b !== index || a !== target) ranges.push({ before: b, beforeEnd: index, after: a, afterEnd: target });
    b = index + 1; a = target + 1;
  });
  if (b !== before.blocks.length || a !== after.blocks.length)
    ranges.push({ before: b, beforeEnd: before.blocks.length, after: a, afterEnd: after.blocks.length });
  for (;;) {
    const owners = new Map<string, number>();
    let joined: readonly [number, number] | undefined;
    for (const [index, range] of ranges.entries()) {
      for (const block of [...before.blocks.slice(range.before, range.beforeEnd), ...after.blocks.slice(range.after, range.afterEnd)]) {
        const prior = owners.get(block.id);
        if (prior !== undefined && prior !== index) { joined = [prior, index]; break; }
        owners.set(block.id, index);
      }
      if (joined) break;
    }
    if (!joined) break;
    const [first, last] = joined, left = ranges[first]!, right = ranges[last]!;
    ranges.splice(first, last - first + 1, { before: left.before, beforeEnd: right.beforeEnd, after: left.after, afterEnd: right.afterEnd });
  }
  return ranges.map(range => ({
    id: id(JSON.stringify([before.blocks.slice(range.before, range.beforeEnd), after.blocks.slice(range.after, range.afterEnd), range.before, range.after])),
    beforeIndex: range.before, afterIndex: range.after,
    beforeBlockIds: before.blocks.slice(range.before, range.beforeEnd).map(block => block.id),
    afterBlockIds: after.blocks.slice(range.after, range.afterEnd).map(block => block.id),
  }));
}
