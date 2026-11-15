import type { Diagnostic } from "@codemirror/lint";

import type { CodeCheckError } from "./codeCheckTypes";

interface OffsetRange { readonly from: number; readonly to: number }

function intersects(first: OffsetRange, second: OffsetRange): boolean {
  return first.from <= second.to && second.from <= first.to;
}

export function codeCheckErrorsToDiagnostics(
  errors: readonly CodeCheckError[],
  cursorPosition: number,
  documentLength: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const suppressions: OffsetRange[] = [];
  for (const error of errors) {
    const range = { from: error.startPos, to: error.endPos };
    if (range.from < 0 || range.to < range.from || range.to > documentLength) continue;
    const cursorAtStart = cursorPosition === range.from + 1;
    const cursorAtEnd = cursorPosition === range.to;
    if (error.suppressIfEditing && (cursorAtStart || cursorAtEnd)) {
      suppressions.push(range);
      continue;
    }
    if (suppressions.some((suppressed) => intersects(suppressed, range))) continue;
    const cursorInRange = range.from <= cursorPosition && cursorPosition <= range.to;
    const cursorAtDocumentEnd = cursorPosition === documentLength;
    const errorAtStart = error.pos === range.from;
    diagnostics.push({
      from: cursorInRange && !errorAtStart && !cursorAtDocumentEnd ? cursorPosition : range.from,
      to: cursorInRange && errorAtStart && !cursorAtDocumentEnd ? cursorPosition : range.to,
      severity: error.type,
      message: error.text,
      source: "Code Check",
    });
  }
  return mergeCompatibleDiagnostics(diagnostics);
}

function mergeCompatibleDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const diagnostic of [...diagnostics].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const previous = result.at(-1);
    if (previous !== undefined
        && previous.message === diagnostic.message
        && previous.severity === diagnostic.severity
        && previous.source === diagnostic.source
        && diagnostic.from <= previous.to) {
      result[result.length - 1] = { ...previous, to: Math.max(previous.to, diagnostic.to) };
    } else {
      result.push(diagnostic);
    }
  }
  return result;
}
