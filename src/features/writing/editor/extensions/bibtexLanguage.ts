import { StreamLanguage, type StreamParser } from "@codemirror/language";

interface BibtexState {
  phase: "outside" | "open" | "key" | "field" | "value";
  kind: string;
  end: string;
  depth: number;
  quoted: boolean;
  commentDepth: number;
}

// BibTeX is not TeX: values can span lines, nest braces and concatenate macros.
// This tokenizer only styles text; bibliography validation remains in its adapter.
export const bibtexParser: StreamParser<BibtexState> = {
  name: "bibtex",
  startState: () => ({ phase: "outside", kind: "", end: "}", depth: 0, quoted: false, commentDepth: 0 }),
  token(stream, state) {
    if (state.commentDepth) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") stream.next();
        else if (ch === (state.end === "}" ? "{" : "(")) state.commentDepth++;
        else if (ch === state.end && --state.commentDepth === 0) { state.phase = "outside"; break; }
      }
      return "comment";
    }
    if (state.depth || state.quoted) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") { stream.next(); continue; }
        if (ch === "{") state.depth++;
        else if (ch === "}" && state.depth > 0) { state.depth--; if (!state.depth && !state.quoted) break; }
        else if (ch === '"' && !state.depth && state.quoted) { state.quoted = false; break; }
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.peek() === "%") { stream.skipToEnd(); return "comment"; }
    if (stream.match(/@[a-zA-Z]+/)) {
      state.kind = stream.current().slice(1).toLowerCase(); state.phase = "open";
      return "keyword";
    }
    if (state.phase === "outside") { stream.next(); return "comment"; }
    const ch = stream.peek();
    if (state.phase === "open" && (ch === "{" || ch === "(")) {
      stream.next(); state.end = ch === "{" ? "}" : ")";
      if (state.kind === "comment") state.commentDepth = 1;
      state.phase = state.kind === "string" ? "field" : state.kind === "preamble" ? "value" : "key";
      return "bracket";
    }
    if (ch === state.end) { stream.next(); state.phase = "outside"; return "bracket"; }
    if (ch === ",") { stream.next(); state.phase = "field"; return "punctuation"; }
    if (ch === "=") { stream.next(); state.phase = "value"; return "operator"; }
    if (state.phase === "key") {
      stream.eatWhile(/[^\s,{}()]/); if (stream.pos === stream.start) stream.next();
      return "atom";
    }
    if (state.phase === "value") {
      if (ch === "{") { stream.next(); state.depth = 1; return "string"; }
      if (ch === '"') { stream.next(); state.quoted = true; return "string"; }
      if (ch === "#") { stream.next(); return "operator"; }
      if (stream.match(/\d+/)) return "number";
      if (stream.match(/[\w:./+-]+/)) return "variableName";
    }
    if (stream.match(/[a-zA-Z][\w-]*/)) return "propertyName.definition";
    stream.next(); return null;
  },
  languageData: { commentTokens: { line: "%" } },
};

export const bibtexLanguage = StreamLanguage.define(bibtexParser);
