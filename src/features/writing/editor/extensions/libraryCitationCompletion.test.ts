// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { acceptCompletion, completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { CitationCandidate } from "@research-assistant/writing";
import { createLatexEditorState } from "../editorState";
import type { LibraryCitationCompletion } from "./libraryCitationCompletion";

const candidate: CitationCandidate = {literatureItemId: "library-only", title: "Neural representations",
  firstAuthor: "Example", issuedYear: 2026, importedKey: "Example2026", containerTitle: "Synthetic Journal",
  hasPdf: false, hasEvidence: false, warnings: []};
const views: EditorView[] = [];
afterEach(() => {for (const view of views.splice(0)) view.destroy(); document.body.replaceChildren();});

function editor(library: LibraryCitationCompletion, text = "\\cite{Neural}", keys: readonly string[] = []) {
  const state = () => createLatexEditorState({content: text,
    getCompletionData: () => ({citationKeys: keys, files: [], labels: [], libraryCitations: library}),
    onChange: vi.fn(), onCursorChange: vi.fn(), onCompile: vi.fn(), onOpenCommands: vi.fn(), codeCheckEnabled: false});
  const view = new EditorView({parent: document.body, state: state()});
  views.push(view);
  view.dispatch({selection: {anchor: text.length - 1}});
  return {view, state};
}

async function choose(view: EditorView) {
  startCompletion(view);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  expect(acceptCompletion(view)).toBe(true);
}

it("searches by title without importing, then inserts only the key confirmed by managed binding", async () => {
  let finish!: (key: string) => void;
  const search = vi.fn(async () => [candidate]);
  const bind = vi.fn(() => new Promise<string>(resolve => {finish = resolve;}));
  const {view} = editor({search, bind, onError: vi.fn()});
  startCompletion(view);
  await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.displayLabel).toBe(candidate.title));
  const option = currentCompletions(view.state)[0];
  expect(option?.detail).toContain("Example · 2026");
  expect(option?.info).toBeUndefined();
  expect(option?.section).toEqual({name: "源自文献库"});
  expect(search).toHaveBeenCalledWith("Neural"); expect(bind).not.toHaveBeenCalled();
  acceptCompletion(view);
  expect(bind).toHaveBeenCalledWith(candidate);
  expect(view.state.doc.toString()).toBe("\\cite{Neural}");
  finish("pinnedImportKey2");
  await vi.waitFor(() => expect(view.state.doc.toString()).toBe("\\cite{pinnedImportKey2}"));
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("\\cite{Neural}");
});

it("retains the input and reports a shared error when bibliography publication fails", async () => {
  const onError = vi.fn(), failure = new Error("projection conflict");
  const {view} = editor({search: async () => [candidate], bind: vi.fn().mockRejectedValue(failure), onError});
  await choose(view);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  expect(view.state.doc.toString()).toBe("\\cite{Neural}");
});

it.each(["edit", "switch"] as const)("does not insert a late key after %s", async action => {
  let finish!: (key: string) => void;
  const onError = vi.fn();
  const {view, state} = editor({search: async () => [candidate], bind: () => new Promise(resolve => {finish = resolve;}), onError});
  await choose(view);
  if (action === "edit") view.dispatch({changes: {from: 0, insert: "% changed\n"}});
  else view.setState(state());
  const current = view.state.doc.toString();
  finish("lateKey");
  await vi.waitFor(() => action === "edit" ? expect(onError).toHaveBeenCalledOnce() : expect(completionStatus(view.state)).toBeNull());
  expect(view.state.doc.toString()).toBe(current);
});

it("keeps existing manuscript keys available when library search fails", async () => {
  const onError = vi.fn(), bind = vi.fn();
  const {view} = editor({search: vi.fn().mockRejectedValue(new Error("offline")), bind, onError}, "\\cite{Local}", ["Local2026"]);
  await choose(view);
  expect(view.state.doc.toString()).toBe("\\cite{Local2026}");
  expect(bind).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce();
});

it("finds an already managed reference by title without duplicating its key-only option", async () => {
  const pinned = {...candidate, citationKey: "ProjectPinned"};
  const bind = vi.fn(async () => "ProjectPinned");
  const {view} = editor({search: async () => [pinned], bind, onError: vi.fn()}, "\\cite{Neural}", ["ProjectPinned"]);
  startCompletion(view);
  await vi.waitFor(() => expect(currentCompletions(view.state)).toHaveLength(1));
  expect(currentCompletions(view.state)[0]?.displayLabel).toBe(candidate.title);
  expect(currentCompletions(view.state)[0]?.section).toBeUndefined();
  acceptCompletion(view);
  await vi.waitFor(() => expect(view.state.doc.toString()).toBe("\\cite{ProjectPinned}"));
});

it("groups manuscript entries before library-only results regardless of search order", async () => {
  const pinned = {...candidate, literatureItemId: "already-managed", citationKey: "ProjectPinned", title: "Managed neural paper"};
  const bind = vi.fn(async () => "ProjectPinned");
  const {view} = editor({search: async () => [candidate, pinned], bind, onError: vi.fn()}, "\\cite{Neural}", ["ProjectPinned", "NeuralLocal"]);
  startCompletion(view);
  await vi.waitFor(() => expect(currentCompletions(view.state)).toHaveLength(3));
  const options = currentCompletions(view.state);
  expect(options.map(option => option.label)).toEqual(["NeuralLocal", "ProjectPinned", "example2026"]);
  expect(options.slice(0, 2).every(option => option.section === undefined)).toBe(true);
  expect(options[2]?.section).toEqual({name: "源自文献库"});
  await vi.waitFor(() => expect(view.dom.querySelector("completion-section")?.textContent).toBe("源自文献库"));
  expect(view.dom.querySelectorAll('[role="option"]')).toHaveLength(3);
});

it("shows no library divider when only manuscript results match", async () => {
  const pinned = {...candidate, citationKey: "ProjectPinned"};
  const {view} = editor({search: async () => [pinned], bind: vi.fn(), onError: vi.fn()}, "\\cite{Neural}", ["ProjectPinned"]);
  startCompletion(view);
  await vi.waitFor(() => expect(currentCompletions(view.state)).toHaveLength(1));
  expect(currentCompletions(view.state)[0]?.section).toBeUndefined();
  expect(view.dom.querySelector("completion-section")).toBeNull();
});

it.each(["\\cite{}", "\\cite{   }", "\\cite{Local2026,}"])("does not search or list suggestions without an input clue: %s", async text => {
  const search = vi.fn(async () => [candidate]);
  const {view} = editor({search, bind: vi.fn(), onError: vi.fn()}, text, ["Local2026"]);
  startCompletion(view);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull());
  expect(search).not.toHaveBeenCalled(); expect(currentCompletions(view.state)).toEqual([]);
});

it("maps the completion insertion through system renames of earlier citation tags", async () => {
  const {citationMigrationTransaction} = await import("./citationIdentity");
  let finish!: (key:string) => void;
  const onError = vi.fn();
  const {view} = editor({search:async () => [candidate],bind:() => new Promise(resolve => {finish=resolve;}),onError},"\\cite{old} \\cite{Neural}");
  await choose(view);
  view.dispatch(citationMigrationTransaction(view.state,[{referenceId:"existing",baseKey:"old",from:"old",to:"old:a"}]));
  finish("chosen:b");
  await vi.waitFor(() => expect(view.state.doc.toString()).toBe("\\cite{old:a} \\cite{chosen:b}"));
  expect(onError).not.toHaveBeenCalled();
});
