/** Project-owned standard LaTeX skeletons; numbered fields use CodeMirror's public syntax. */
export const environmentNames = [
  "abstract", "align", "align*", "array", "center", "description", "document", "equation", "equation*",
  "enumerate", "figure", "frame", "gather", "gather*", "itemize", "multline", "multline*", "quote", "split",
  "table", "tabular", "verbatim", "figure*", "table*", "theorem", "proof",
] as const;

const field = (number: number, value = "") => `\${${number}${value ? `:${value}` : ""}}`;

export function environmentTemplate(name: string, existingArguments = ""): string {
  let header = `\\begin{${name}}`, body = `\t${field(1)}`;
  switch (name) {
    case "document": body = field(1); break;
    case "itemize": case "enumerate": body = `\t\\item ${field(1)}`; break;
    case "description": body = `\t\\item[${field(1)}] ${field(2)}`; break;
    case "array": case "tabular":
      header += `{${field(1, name === "array" ? "cc" : "c|c")}}`;
      body = `\t${field(2)} & ${field(3)} \\\\\n\t${field(4)} & ${field(5)}`;
      break;
    case "frame": header += `{${field(1, "Frame Title")}}`; body = `\t${field(2)}`; break;
    case "figure": case "figure*":
      body = `\t\\centering\n\t\\includegraphics[width=0.5\\linewidth]{${field(1)}}\n\t\\caption{${field(2, "Caption")}}\n\t\\label{${field(3, "fig:placeholder")}}`;
      break;
    case "table": case "table*":
      header += `[${field(1)}]`;
      body = `\t\\centering\n\t\\begin{tabular}{${field(2, "c|c")}}\n\t\t${field(3)} & ${field(4)} \\\\\n\t\t${field(5)} & ${field(6)}\n\t\\end{tabular}\n\t\\caption{${field(7, "Caption")}}\n\t\\label{${field(8, "tab:placeholder")}}`;
      break;
  }
  if (existingArguments) header = `\\begin{${name}}${existingArguments.replace(/[{}]/gu, "\\$&")}`;
  return `${header}\n${body}\n\\end{${name}}${field(0)}`;
}
