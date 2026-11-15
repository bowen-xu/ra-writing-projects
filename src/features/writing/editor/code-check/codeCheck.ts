import { Compartment, type Extension } from "@codemirror/state";
import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import type { EditorView, ViewUpdate } from "@codemirror/view";

import { codeCheckErrorsToDiagnostics } from "./codeCheckDiagnostics";
import type { CodeCheckResult } from "./codeCheckTypes";

export const codeCheckCompartment = new Compartment();

let worker: Worker | undefined;
let nextRequestId = 0;
const pending = new Map<number, { readonly resolve: (result: CodeCheckResult) => void; readonly reject: (reason: unknown) => void }>();

function codeCheckWorker(): Worker {
  if (worker !== undefined) return worker;
  worker = new Worker(new URL("./overleafCodeCheck.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<CodeCheckResult>) => {
    const request = pending.get(event.data.requestId);
    if (request === undefined) return;
    pending.delete(event.data.requestId);
    request.resolve(event.data);
  });
  worker.addEventListener("error", (event) => {
    for (const request of pending.values()) request.reject(event.error ?? new Error(event.message));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  });
  return worker;
}

async function runCodeCheck(view: EditorView, onResult: (hasErrors: boolean) => void): Promise<Diagnostic[]> {
  const requestId = ++nextRequestId;
  const result = await new Promise<CodeCheckResult>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    codeCheckWorker().postMessage({ requestId, text: view.state.doc.toString() });
  });
  const diagnostics = codeCheckErrorsToDiagnostics(
    result.errors,
    view.state.selection.main.head,
    view.state.doc.length,
  );
  onResult(result.errors.some((error) => error.type !== "info"));
  return diagnostics;
}

export function codeCheckExtension(enabled: boolean, onResult: (hasErrors: boolean) => void): Extension {
  if (!enabled) return [];
  return [
    linter((view) => runCodeCheck(view, onResult), {
      delay: 100,
      markerFilter: (diagnostics) => diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      needsRefresh: (update: ViewUpdate) => update.selectionSet,
    }),
    lintGutter(),
  ];
}
