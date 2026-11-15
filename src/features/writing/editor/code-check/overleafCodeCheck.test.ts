import { describe, expect, it } from "vitest";

import OverleafCodeCheckWorker from "./overleafCodeCheck.worker";
import { codeCheckErrorsToDiagnostics } from "./codeCheckDiagnostics";

const parse = new OverleafCodeCheckWorker().Parse;

describe("Overleaf Code Check", () => {
  it.each([
    "\\begin{document}Text\\end{document}",
    "Inline $a_b^2$ text.",
    "\\begin{equation}\\left(x\\right)\\end{equation}",
    "\\newcommand{\\beq}{\\begin{equation}}",
    "\\verb|$not_math$| and \\url{https://example.test/a_b}",
  ])("accepts valid or deliberately opaque LaTeX: %s", (source) => {
    expect(parse(source).errors).toEqual([]);
  });

  it.each([
    ["text_a", "_ must be inside math mode"],
    ["text^a", "^ must be inside math mode"],
    ["\\begin{figure}x\\end{table}", "unclosed \\begin{figure} found at \\end{table}"],
    ["$a", "unclosed $"],
    ["\\left(", "\\left can only be used in math mode"],
  ])("reports structural errors in %s", (source, message) => {
    expect(parse(source).errors.some((error) => error.text.includes(message))).toBe(true);
  });

  it("supports whole-file and region novalidate directives", () => {
    expect(parse("%%novalidate\ntext_a").errors).toEqual([]);
    expect(parse("text_a\n%%begin novalidate\nmore_bad^x\n%%end novalidate\n$ok$").errors).toHaveLength(1);
  });

  it("preserves warning and information severities used by compile gating", () => {
    expect(parse("\\begin{document}{\\end{document}").errors.some((error) => error.type === "warning")).toBe(true);
    expect(parse("\\begin{document}\\end{document}\\end{figure}").errors.some((error) => error.type === "info")).toBe(true);
  });

  it("caps pathological input instead of hanging", () => {
    expect(() => parse("{".repeat(100_001))).toThrow(/max token count/);
  });
});

describe("Code Check diagnostic adaptation", () => {
  it("suppresses an incomplete construct while the cursor edits its edge", () => {
    const errors = parse("\\begin{}").errors;
    expect(codeCheckErrorsToDiagnostics(errors, 7, 8)).toEqual([]);
    expect(codeCheckErrorsToDiagnostics(errors, 6, 8)).toHaveLength(1);
  });

  it("drops stale ranges and labels diagnostics with their source", () => {
    const diagnostics = codeCheckErrorsToDiagnostics([
      { startPos: 0, endPos: 2, pos: 0, type: "error", text: "first" },
      { startPos: 9, endPos: 12, pos: 9, type: "error", text: "stale" },
    ], 4, 10);
    expect(diagnostics).toEqual([{ from: 0, to: 2, severity: "error", message: "first", source: "Code Check" }]);
  });
});
