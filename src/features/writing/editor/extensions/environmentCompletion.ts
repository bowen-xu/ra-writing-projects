import { clearSnippet, insertCompletionText, pickedCompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { scanLatexEnvironments, type LatexEnvironmentScan } from "@research-assistant/writing";
import type { EditorView } from "@codemirror/view";
import { environmentNames, environmentTemplate } from "./environmentTemplates";

function namesInDocument(scan: LatexEnvironmentScan, position: number): string[] {
  return [...new Set([...environmentNames, ...scan.tokens.filter(token => !(token.from < position && position <= token.to)).map(token => token.name)])];
}

function beginOption(name: string, command = false, boost = 0): Completion {
  const label = `${command ? "" : "\\"}begin{${name}} …`;
  return {label, displayLabel: `\\begin{${name}} …`, type: "type", boost,
    apply: (view, completion, from, to) => applyEnvironment(view, completion, command ? from - 1 : from, to, name)};
}

/** Environment snippets are also discoverable while typing a command, e.g. \\itemi. */
export function environmentCommandOptions(context: CompletionContext): readonly Completion[] {
  const scan = scanLatexEnvironments(context.state.doc.toString());
  if (scan.excluded.some(range => range.from < context.pos && context.pos <= range.to)) return [];
  return namesInDocument(scan, context.pos).map(name => beginOption(name, true));
}

export function environmentCompletions(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos), before = context.state.sliceDoc(line.from, context.pos);
  const match = /(?<!\\)\\(begin|end)\{([A-Za-z0-9*@:_-]*)(\})?$/u.exec(before);
  if (!match) return null;
  const source = context.state.doc.toString(), scan = scanLatexEnvironments(source);
  const excluded = scan.excluded.find(range => range.from < context.pos && context.pos <= range.to);
  const literal = excluded && scan.tokens.find(token => token.kind === "begin" && token.to === excluded.from);
  if (excluded && !(match[1] === "end" && literal)) return {from: context.pos, options: []};
  const from = line.from + match.index, prefix = match[2] ?? "";
  if (match[1] === "begin") {
    const names = namesInDocument(scan, context.pos);
    const existingName = /^\\begin\{([A-Za-z][A-Za-z0-9*@:_-]*)\}/u.exec(source.slice(from))?.[1];
    if (existingName && !names.includes(existingName)) names.push(existingName);
    const options = names.map(name => beginOption(name));
    if (/^[A-Za-z][A-Za-z0-9*@:_-]*$/u.test(prefix) && !names.includes(prefix)) options.push(beginOption(prefix, false, -99));
    // Requery while typing so a newly typed custom name is offered immediately.
    return {from, options};
  }
  const open: string[] = [];
  for (const token of scan.tokens) {
    if (token.to > from) break;
    if (token.kind === "begin") open.push(token.name);
    else if (token.kind === "end") {
      const index = open.lastIndexOf(token.name);
      if (index >= 0) open.splice(index, 1);
    }
  }
  const names = literal ? [literal.name] : [...new Set(open.reverse())];
  return {from: from + "\\end{".length, options: names.map((name, index) => ({label: name, boost: 99 - Math.min(index, 99),
    apply: (view, completion, start, end) => {
      const suffix = /^[A-Za-z0-9*@:_-]*\}?/u.exec(view.state.sliceDoc(end))?.[0] ?? "";
      view.dispatch({...insertCompletionText(view.state, `${name}}`, start, end + suffix.length), annotations: pickedCompletion.of(completion)});
    }})), validFor: /^[A-Za-z0-9*@:_-]*$/u};
}

function headerArguments(source: string, from: number): string {
  let offset = from;
  while (source[offset] === "[" || source[offset] === "{") {
    const stack = [source[offset] === "[" ? "]" : "}"];
    let end = offset + 1;
    for (; end < source.length && stack.length && source[end] !== "\n"; end++) {
      const char = source[end];
      if (char === "\\") {end++; continue;}
      if (char === "{") stack.push("}");
      else if (char === "[" && stack.at(-1) === "]") stack.push("]");
      else if (char === stack.at(-1)) stack.pop();
    }
    if (stack.length) break;
    offset = end;
  }
  return source.slice(from, offset);
}

function applyEnvironment(view: EditorView, completion: Completion, from: number, to: number, name: string): void {
  const source = view.state.doc.toString();
  const header = /^\\begin\{[A-Za-z0-9*@:_-]*\}?/u.exec(source.slice(from));
  if (header) to = Math.max(to, from + header[0].length);
  const argumentsText = headerArguments(source, to);
  to += argumentsText.length;
  let depth = 1;
  for (const token of scanLatexEnvironments(source).tokens) {
    if (token.from < to || token.name !== name || token.kind === "definition") continue;
    depth += token.kind === "begin" ? 1 : -1;
    if (!depth) {
      // A user-written body/end already exists. Complete just its header.
      view.dispatch({...insertCompletionText(view.state, `\\begin{${name}}${argumentsText}`, from, to), annotations: pickedCompletion.of(completion)});
      return;
    }
  }
  snippet(environmentTemplate(name, argumentsText))(view, completion, from, to);
  if (["abstract", "itemize", "enumerate"].includes(name)) clearSnippet(view);
}
