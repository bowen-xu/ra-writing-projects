import type { AgentReviewContent } from "@research-assistant/core/agent";
import type { DemoChange } from "@research-assistant/workbench-preview/writing-diff-fixtures";

/** The native review gateway limits text rendering, never stored file bytes. */
export function writingDiffDemoContent(bytes: Uint8Array): AgentReviewContent {
  if (bytes.byteLength > 1024 * 1024) return { kind: "tooLarge" };
  const text = writingDiffDemoText(bytes);
  return text === null ? { kind: "binary" } : { kind: "text", text };
}

/** Source editing has a separate limit from the bounded historical preview. */
export function writingDiffDemoText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
}

export function writingDiffDemoBytes(change: DemoChange, side: "before" | "after"): Uint8Array {
  const bytes = side === "before" ? change.beforeBytes : change.afterBytes;
  return bytes ? Uint8Array.from(bytes) : new TextEncoder().encode(change[side]);
}

export function sameWritingDiffDemoBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
