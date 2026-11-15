import { EditorDiffControls } from "@research-assistant/workbench-sdk/editor-review";
import { EditorView } from "@codemirror/view";
import { getChunks, getOriginalDoc, originalDocChangeEffect } from "@codemirror/merge";
import { isolateHistory } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import { useEffect, useRef, useState } from "react";
import type { CompileDiagnostic, WritingDocumentContent } from "@research-assistant/writing";

import { createLatexEditorState, type EditorStateOptions } from "./editorState";
import type { WritingFileSession } from "./writingFileSessions";
import type { LatexCompletionData } from "./extensions/latexCompletion";
import { editorPreferencesCompartment, editorPreferenceExtensions, type EditorPreferences } from "./editorPreferences";
import { codeCheckCompartment, codeCheckExtension } from "./code-check/codeCheck";
import { compileDiagnosticsCompartment, compileDiagnosticsExtension } from "./compileDiagnostics";
import type { LatexEditorDiffOptions } from "./editorState";
import type { WritingDiffControls } from "./writingDiffTypes";
import { resolveWritingChunk, resolveWritingDiff, writingTextChanges } from "./writingDiffCommands";
import { refreshCitationReferences } from "./extensions/citationReferences";
import { EditorDiffHighlight, type EditorDiffHighlightAppearance } from "@research-assistant/workbench-sdk/editor-review";

interface LatexEditorProps {
  readonly diffHighlight?: EditorDiffHighlightAppearance;
  readonly active?: boolean;
  readonly suspended?: boolean;
  readonly documentKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onDocumentChange?: (document: WritingDocumentContent) => void;
  readonly onCompile: () => void;
  readonly onOpenCommands: () => void;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly focusRequest: import("../sourceNavigation").WritingFocusRequest | undefined;
  readonly insertionRequest?: { readonly text: string; readonly token: number };
  readonly initialCursor?: number;
  readonly onCursorChange: (offset: number) => void;
  readonly completionData: LatexCompletionData;
  readonly preferences?: EditorPreferences;
  readonly onReady?: (view: EditorView | null) => void;
  readonly codeCheckEnabled: boolean;
  readonly onCodeCheckResult: (hasErrors: boolean) => void;
  readonly diff?: {
    readonly before: string;
    readonly after: string;
    readonly controls?: WritingDiffControls;
  };
  readonly fileSession?: WritingFileSession;
}

export function LatexEditor({ active = true, suspended = false, documentKey, value, onChange, onDocumentChange, onCompile, onOpenCommands, diagnostics, focusRequest, insertionRequest, initialCursor, onCursorChange, completionData, preferences, onReady, codeCheckEnabled, onCodeCheckResult, diff, fileSession, diffHighlight }: LatexEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const sessionRef = useRef<WritingFileSession | undefined>(fileSession);
  const onChangeRef = useRef(onChange);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onReadyRef = useRef(onReady);
  const onCompileRef = useRef(onCompile);
  const onOpenCommandsRef = useRef(onOpenCommands);
  const onCursorChangeRef = useRef(onCursorChange);
  const completionDataRef = useRef(completionData);
  const onCodeCheckResultRef = useRef(onCodeCheckResult);
  const codeCheckEnabledRef = useRef(codeCheckEnabled);
  const codeCheckGenerationRef = useRef(0);
  const suspendedRef = useRef(suspended); suspendedRef.current = suspended;
  const activeRef = useRef(active); activeRef.current = active;
  const diffControlsRef = useRef(diff?.controls);
  const externalRef = useRef({ value, before: diff?.before, after: diff?.after });
  const handledFocus = useRef<number | undefined>(undefined);
  const handledInsertion = useRef<number | undefined>(undefined);
  const [summary, setSummary] = useState({ count: 0, precise: true });
  const [activeChunk, setActiveChunk] = useState(1);
  onChangeRef.current = onChange;
  onDocumentChangeRef.current = onDocumentChange;
  onReadyRef.current = onReady;
  onCompileRef.current = onCompile;
  onOpenCommandsRef.current = onOpenCommands;
  onCursorChangeRef.current = onCursorChange;
  completionDataRef.current = completionData;
  onCodeCheckResultRef.current = onCodeCheckResult;
  codeCheckEnabledRef.current = codeCheckEnabled;
  diffControlsRef.current = diff?.controls;

  function resolveChunk(view: EditorView, position: number, action: "keep" | "undo"): void {
    const resolved = resolveWritingChunk(view, position, action);
    if (!resolved) return;
    // Keeping a chunk updates the merge baseline while the visible document
    // can remain byte-for-byte identical. Publish the current document
    // explicitly so the workspace snapshot survives leaving Diff mode.
    onChangeRef.current(view.state.doc.toString());
    diffControlsRef.current?.onResolveChange?.({ action, before: getOriginalDoc(view.state).toString(), after: view.state.doc.toString() });
    view.focus();
  }

  function move(direction: "next" | "previous"): void {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state)?.chunks ?? [];
    if (!chunks.length) return;
    const cursor = view.state.selection.main.head;
    const currentIndex = chunks.findIndex((chunk) => chunk.fromB <= cursor && cursor <= chunk.endB);
    const targetIndex = direction === "next"
      ? currentIndex >= 0 ? currentIndex + 1 : chunks.findIndex((chunk) => chunk.fromB > cursor)
      : currentIndex >= 0 ? currentIndex - 1 : chunks.reduce((last, chunk, index) => chunk.endB < cursor ? index : last, -1);
    if (targetIndex < 0 || targetIndex >= chunks.length) return;
    const target = chunks[targetIndex];
    if (!target) return;
    view.dispatch({ selection: { anchor: target.fromB }, scrollIntoView: true });
    view.focus();
  }

  function resolveCurrent(action: "keep" | "undo"): void {
    const view = viewRef.current;
    const chunk = view && getChunks(view.state)?.chunks[activeChunk - 1];
    if (view && chunk) resolveChunk(view, chunk.fromB, action);
  }

  function resolveAll(action: "keep" | "undo"): void {
    const view = viewRef.current;
    const controls = diffControlsRef.current;
    if (!view) return;
    if (!resolveWritingDiff(view, action)) return;
    onChangeRef.current(view.state.doc.toString());
    // Notify observers of the completed local transaction. Legacy proposal
    // application callbacks must not re-dispatch this review decision.
    controls?.onResolveChange?.({ action, before: getOriginalDoc(view.state).toString(), after: view.state.doc.toString() });
    view.focus();
  }

  useEffect(() => {
    if (hostRef.current === null) return;
    const generation = codeCheckGenerationRef.current;
    const preserveCursor = fileSession?.hasBeenOpened === true;
    const retained = preserveCursor || (fileSession?.read().version ?? 0) > 0;
    const options: EditorStateOptions = {
        content: diff?.after ?? value,
        filePath: documentKey,
        onChange: (content) => {if (!suspendedRef.current) onChangeRef.current(content);},
        onDocumentChange: (document) => {if (!suspendedRef.current) onDocumentChangeRef.current?.(document);},
        onCompile: () => onCompileRef.current(),
        onOpenCommands: () => onOpenCommandsRef.current(),
        onCursorChange: (offset) => {if (!suspendedRef.current) onCursorChangeRef.current(offset);},
        getCompletionData: () => completionDataRef.current,
        codeCheckEnabled: codeCheckEnabled && activeRef.current,
        onCodeCheckResult: (hasErrors) => {
          if (generation === codeCheckGenerationRef.current && codeCheckEnabledRef.current && activeRef.current) {
            onCodeCheckResultRef.current(hasErrors);
          }
        },
        diff: {
          before: diff?.before ?? value,
          after: diff?.after ?? value,
          onResolveChunk: resolveChunk,
        } satisfies LatexEditorDiffOptions,
        onUpdate: (update) => {
          const chunks = getChunks(update.state)?.chunks ?? [];
          setSummary({ count: chunks.length, precise: chunks.every((chunk) => chunk.precise) });
          const cursorChunk = chunks.findIndex((chunk) => chunk.fromB <= update.state.selection.main.head && update.state.selection.main.head <= chunk.endB);
          if (cursorChunk >= 0) setActiveChunk(cursorChunk + 1);
          setActiveChunk((current) => chunks.length === 0 ? 0 : current === 0 ? 1 : Math.min(current, chunks.length));
        },
        ...(initialCursor === undefined ? {} : { initialCursor }),
        ...(preferences === undefined ? {} : { preferences }),
      };
    const state = fileSession?.configureHost(options) ?? createLatexEditorState(options);
    let view = viewRef.current;
    if (view) view.setState(state);
    else {
      view = new EditorView({ parent: hostRef.current, state,
        dispatchTransactions: (transactions, editor) => {
          const session = sessionRef.current;
          if (session) session.accept(transactions);
          else editor.update(transactions);
        },
      });
    }
    viewRef.current = view;
    sessionRef.current = fileSession;
    fileSession?.attach(view);
    externalRef.current = { value, before: diff?.before, after: diff?.after };
    if (!retained && diff !== undefined && view.state.doc.toString() !== diff.after) {
      view.dispatch({ changes: writingTextChanges(view.state.doc.toString(), diff.after), annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.agent")] });
    }
    if (!preserveCursor && initialCursor !== undefined) view.dispatch({ selection: { anchor: Math.min(Math.max(initialCursor, 0), view.state.doc.length) } });
    const chunks = getChunks(view.state)?.chunks ?? [];
    setSummary({ count: chunks.length, precise: chunks.every((chunk) => chunk.precise) });
    const cursorChunk = chunks.findIndex((chunk) => chunk.fromB <= view.state.selection.main.head && view.state.selection.main.head <= chunk.endB);
    setActiveChunk(chunks.length === 0 ? 0 : cursorChunk < 0 ? 1 : cursorChunk + 1);
    onReadyRef.current?.(suspendedRef.current ? null : view);
    if (activeRef.current) view.focus();
    return () => {
      codeCheckGenerationRef.current += 1;
      onReadyRef.current?.(null);
      fileSession?.detach(view);
      sessionRef.current = undefined;
    };
  }, [documentKey, fileSession]);

  useEffect(() => {
    onReadyRef.current?.(suspended ? null : viewRef.current);
    if (active) viewRef.current?.focus();
  }, [active, suspended]);

  useEffect(() => () => {
    viewRef.current?.destroy();
    viewRef.current = null;
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const previous = externalRef.current;
    externalRef.current = { value, before: diff?.before, after: diff?.after };
    const baselineChanged = diff?.before !== undefined && previous.before !== diff.before;
    const afterChanged = previous.after !== diff?.after || previous.value !== value;
    if (!baselineChanged && !afterChanged) return;
    const original = getOriginalDoc(view.state).toString();
    const next = diff?.after ?? value;
    view.dispatch({
      ...(afterChanged && view.state.doc.toString() !== next ? { changes: writingTextChanges(view.state.doc.toString(), next) } : {}),
      ...(baselineChanged && original !== diff.before ? { effects: originalDocChangeEffect(view.state, writingTextChanges(original, diff.before)) } : {}),
      annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.agent")],
    });
  }, [documentKey, diff?.before, diff?.after, value]);

  useEffect(() => {
    if (preferences !== undefined) viewRef.current?.dispatch({ effects: editorPreferencesCompartment.reconfigure(editorPreferenceExtensions(preferences)) });
  }, [preferences, documentKey, fileSession]);

  useEffect(() => {
    viewRef.current?.dispatch({effects: refreshCitationReferences.of(null)});
  }, [completionData.citationReferences, documentKey, fileSession]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const generation = ++codeCheckGenerationRef.current;
    if (!codeCheckEnabled || !active) onCodeCheckResultRef.current(false);
    view.dispatch({ effects: codeCheckCompartment.reconfigure(codeCheckExtension(codeCheckEnabled && active, (hasErrors) => {
      if (generation === codeCheckGenerationRef.current && codeCheckEnabledRef.current) {
        onCodeCheckResultRef.current(hasErrors);
      }
    })) });
  }, [codeCheckEnabled, active, documentKey, fileSession]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: compileDiagnosticsCompartment.reconfigure(compileDiagnosticsExtension(diagnostics)) });
  }, [diagnostics, documentKey, fileSession]);

  useEffect(() => {
    const view = viewRef.current;
    if (!active || view === null || focusRequest === undefined || handledFocus.current === focusRequest.token) return;
    handledFocus.current = focusRequest.token;
    try {
      const range = focusRequest.range;
      const line = view.state.doc.line(Math.min(Math.max(focusRequest.line, 1), view.state.doc.lines));
      let anchor = line.from, head = anchor;
      if (range) {
        if (range.endLine > view.state.doc.lines) throw new Error("来源行号超出当前文件，文件可能已变化");
        const start = view.state.doc.line(range.startLine), end = view.state.doc.line(range.endLine);
        const startChars = Array.from(start.text), endChars = Array.from(end.text);
        if (range.startColumn > startChars.length || range.endColumn > endChars.length) throw new Error("来源列号超出当前文件，文件可能已变化");
        anchor = start.from + startChars.slice(0, range.startColumn - 1).join("").length;
        head = end.from + endChars.slice(0, range.endColumn).join("").length;
      }
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      view.focus(); focusRequest.onLocated?.({getAnchorRect: () => {
        if (!view.dom.isConnected) return null;
        const position = view.coordsAtPos(anchor);
        return position ? new DOMRect(position.left, position.top, Math.max(1, position.right - position.left), position.bottom - position.top) : null;
      }});
    } catch (reason) { focusRequest.onError?.(reason); }
  }, [active, documentKey, focusRequest]);

  useEffect(() => {
    const view = viewRef.current;
    if (!active || view === null || view.state.readOnly || insertionRequest === undefined || handledInsertion.current === insertionRequest.token) return;
    handledInsertion.current = insertionRequest.token;
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: insertionRequest.text },
      selection: { anchor: selection.from + insertionRequest.text.length },
      scrollIntoView: true,
    });
    view.focus();
  }, [active, documentKey, insertionRequest]);

  const hasDiff = summary.count > 0;
  return <EditorDiffHighlight appearance={diffHighlight}><div className={hasDiff ? "writing-text-diff writing-editor-diff-surface" : undefined} aria-label={hasDiff ? "逐行修改比较" : undefined} style={{ height: "100%" }}>
    <EditorDiffControls count={summary.count} active={activeChunk} onMove={move}
      onResolve={(action, scope) => scope === "all" ? resolveAll(action) : resolveCurrent(action)} />
    <div aria-label={hasDiff ? "逐行差异编辑器" : "LaTeX 源码编辑器"} ref={hostRef} style={{ height: "100%" }} />
  </div></EditorDiffHighlight>;
}
