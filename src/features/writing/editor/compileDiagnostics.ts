import { linter, type Diagnostic } from "@codemirror/lint";
import { Compartment, type Extension } from "@codemirror/state";
import type { CompileDiagnostic } from "@research-assistant/writing";

export const compileDiagnosticsCompartment = new Compartment();

export function compileDiagnosticsExtension(diagnostics: readonly CompileDiagnostic[]): Extension {
  if (diagnostics.length === 0) return [];
  return linter((view): Diagnostic[] => diagnostics.map((diagnostic) => {
    const lineNumber = Math.min(Math.max(diagnostic.line ?? 1, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    return {
      from: line.from,
      to: line.to,
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: "LaTeX",
    };
  }), { delay: 0 });
}
