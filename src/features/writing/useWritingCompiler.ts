import type { CompileRun, LatexEngine, LatexToolchainInfo } from "@research-assistant/writing";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WritingGateway } from "./gateway";
import { errorMessage, type SaveState } from "./workspaceState";
import { readCompilePreferences, type CompilePreferences } from "./compilePreferences";

interface WritingCompilerOptions {
  readonly compilePreferences?: CompilePreferences;
  readonly autoCompile: boolean;
  readonly gateway: WritingGateway;
  readonly manuscriptId: string | undefined;
  readonly saveCurrent: () => Promise<boolean>;
  readonly saveState: SaveState;
  readonly setError: (message: string | undefined) => void;
  readonly hasCodeCheckErrors: boolean;
}

interface WritingCompiler {
  readonly cancel: () => Promise<void>;
  readonly engine: LatexEngine;
  readonly isCompiling: boolean;
  readonly isPdfStale: boolean;
  readonly markSourceChanged: () => void;
  readonly pdfBytes: Uint8Array | undefined;
  readonly run: CompileRun | undefined;
  readonly setEngine: (engine: LatexEngine) => void;
  readonly start: (fromScratch?: boolean) => Promise<void>;
  readonly pdfRun: CompileRun | undefined;
  readonly toolchain: LatexToolchainInfo | undefined;
}

interface StartCompileAfterSaveOptions {
  readonly cancelCompile: (runId: string) => Promise<void>;
  readonly isCancelled: () => boolean;
  readonly onPreparing: () => void;
  readonly onRun: (run: CompileRun) => void;
  readonly saveCurrent: () => Promise<boolean>;
  readonly startCompile: () => Promise<CompileRun>;
}

export async function startCompileAfterSave(options: StartCompileAfterSaveOptions): Promise<void> {
  options.onPreparing();
  if (!(await options.saveCurrent()) || options.isCancelled()) return;
  const run = await options.startCompile();
  if (options.isCancelled()) {
    await options.cancelCompile(run.id);
    return;
  }
  options.onRun(run);
}

interface ApplyCompilePollResultOptions {
  readonly isCurrent: (run: CompileRun) => Promise<boolean>;
  readonly onActive: (run: CompileRun) => void;
  readonly onPdfReady: (run: CompileRun, bytes: Uint8Array, isCurrent: boolean) => void;
  readonly onTerminal: (run: CompileRun) => void;
  readonly readPdf: (run: CompileRun) => Promise<Uint8Array>;
}

export async function applyCompilePollResult(
  run: CompileRun,
  options: ApplyCompilePollResultOptions,
): Promise<boolean> {
  if (run.status === "queued" || run.status === "running") {
    options.onActive(run);
    return true;
  }
  if (run.status === "succeeded"
      || (run.status === "failed" && run.artifacts.some((artifact) => artifact.kind === "pdf"))) {
    const [bytes, isCurrent] = await Promise.all([
      options.readPdf(run),
      options.isCurrent(run),
    ]);
    options.onPdfReady(run, bytes, isCurrent);
    return false;
  }
  options.onTerminal(run);
  return false;
}

export function codeCheckBlocksAutoCompile(
  preferences: CompilePreferences | undefined,
  hasCodeCheckErrors: boolean,
): boolean {
  return readCompilePreferences(preferences).codeCheck && hasCodeCheckErrors;
}

export function useWritingCompiler(options: WritingCompilerOptions): WritingCompiler {
  const [toolchain, setToolchain] = useState<LatexToolchainInfo>();
  const [engine, setEngine] = useState<LatexEngine>("pdflatex");
  const [run, setRun] = useState<CompileRun>();
  const [pdfRun, setPdfRun] = useState<CompileRun>();
  const [pdfBytes, setPdfBytes] = useState<Uint8Array>();
  const [isPdfStale, setIsPdfStale] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const isStartingRef = useRef(false);
  const startCancelledRef = useRef(false);
  const startSequenceRef = useRef(0);
  const sourceRevisionRef = useRef(0);
  const runRevisionRef = useRef(new Map<string, number>());
  const lastCompileAttemptRevisionRef = useRef<number | undefined>(undefined);
  const hasActiveRun = run?.status === "queued" || run?.status === "running";
  const isCompiling = isStarting || hasActiveRun;

  useEffect(() => {
    let active = true;
    void options.gateway.detectToolchain()
      .then((value) => {
        if (!active) return;
        setToolchain(value);
        const preferred = value.supportedEngines.includes("pdflatex")
          ? "pdflatex"
          : value.supportedEngines[0];
        if (preferred !== undefined) setEngine(preferred);
      })
      .catch((reason: unknown) => active && options.setError(errorMessage(reason)));
    return () => { active = false; };
  }, [options.gateway, options.setError]);

  useEffect(() => {
    startSequenceRef.current += 1;
    startCancelledRef.current = true;
    isStartingRef.current = false;
    setIsStarting(false);
    sourceRevisionRef.current = 0;
    runRevisionRef.current.clear();
    lastCompileAttemptRevisionRef.current = undefined;
    setRun(undefined);
    setPdfRun(undefined);
    setPdfBytes(undefined);
    setIsPdfStale(false);
    if (options.manuscriptId === undefined) return;
    let active = true;
    void Promise.all([
      options.gateway.getLatestCompileRun(options.manuscriptId),
      options.gateway.getLatestPdfCompileRun(options.manuscriptId),
    ]).then(async ([latest, preview]) => {
      if (!active) return;
      setRun(latest);
      setPdfRun(preview);
      if (preview === undefined) return;
      const [bytes, isCurrent] = await Promise.all([
        options.gateway.readCompilePdf(preview.id),
        options.gateway.isCompileCurrent(preview.id),
      ]);
      if (active) {
        setPdfBytes(bytes);
        setIsPdfStale(!isCurrent);
      }
    }).catch((reason: unknown) => active && options.setError(errorMessage(reason)));
    return () => { active = false; };
  }, [options.gateway, options.manuscriptId, options.setError]);

  useEffect(() => {
    if (run === undefined || !["queued", "running"].includes(run.status)) return;
    let active = true;
    let timeout: number | undefined;
    const poll = async (): Promise<void> => {
      let next: CompileRun | undefined;
      try {
        next = await options.gateway.getCompileRun(run.id);
        if (!active) return;
        const startedRevision = runRevisionRef.current.get(next.id);
        const shouldContinue = await applyCompilePollResult(next, {
          isCurrent: (completed) => startedRevision === undefined
            ? options.gateway.isCompileCurrent(completed.id)
            : Promise.resolve(startedRevision === sourceRevisionRef.current),
          onActive: setRun,
          onPdfReady: (completed, bytes, isCurrent) => {
            if (!active) return;
            setRun(completed);
            setPdfBytes(bytes);
            setPdfRun(completed);
            setIsPdfStale(!isCurrent);
          },
          onTerminal: setRun,
          readPdf: (completed) => options.gateway.readCompilePdf(completed.id),
        });
        if (!active) return;
        if (shouldContinue) {
          timeout = window.setTimeout(() => void poll(), 300);
        } else {
          runRevisionRef.current.delete(next.id);
        }
      } catch (reason: unknown) {
        if (active) {
          if (next !== undefined && !["queued", "running"].includes(next.status)) setRun(next);
          options.setError(errorMessage(reason));
        }
      }
    };
    timeout = window.setTimeout(() => void poll(), 200);
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [options.gateway, options.setError, run?.id, run?.status]);

  const start = useCallback(async (fromScratch = false): Promise<void> => {
    const manuscriptId = options.manuscriptId;
    if (manuscriptId === undefined
        || toolchain?.available !== true
        || isStartingRef.current
        || hasActiveRun) return;
    options.setError(undefined);
    startCancelledRef.current = false;
    const sequence = ++startSequenceRef.current;
    try {
      let revision = sourceRevisionRef.current;
      await startCompileAfterSave({
        cancelCompile: options.gateway.cancelCompile,
        isCancelled: () => startCancelledRef.current || startSequenceRef.current !== sequence,
        onPreparing: () => {
          isStartingRef.current = true;
          setIsStarting(true);
        },
        onRun: (next) => {
          runRevisionRef.current.set(next.id, revision);
          lastCompileAttemptRevisionRef.current = revision;
          setRun(next);
        },
        saveCurrent: options.saveCurrent,
        startCompile: () => {
          revision = sourceRevisionRef.current;
          const preferences = readCompilePreferences(options.compilePreferences);
          return options.gateway.startCompile(manuscriptId, engine, {
            draft: preferences.draft,
            stopOnFirstError: preferences.stopOnFirstError,
            fromScratch,
          });
        },
      });
    } catch (reason: unknown) {
      if (startSequenceRef.current === sequence) options.setError(errorMessage(reason));
    } finally {
      if (startSequenceRef.current === sequence) {
        isStartingRef.current = false;
        setIsStarting(false);
      }
    }
  }, [
    engine,
    options.compilePreferences,
    hasActiveRun,
    options.gateway,
    options.manuscriptId,
    options.saveCurrent,
    options.setError,
    toolchain?.available,
  ]);

  const cancel = useCallback(async (): Promise<void> => {
    if (isStartingRef.current) {
      startCancelledRef.current = true;
      return;
    }
    if (run === undefined || !["queued", "running"].includes(run.status)) return;
    try {
      await options.gateway.cancelCompile(run.id);
    } catch (reason: unknown) {
      options.setError(errorMessage(reason));
    }
  }, [options.gateway, options.setError, run]);

  const markSourceChanged = useCallback(() => {
    sourceRevisionRef.current += 1;
    setIsPdfStale(true);
  }, []);

  useEffect(() => {
    if (!options.autoCompile
        || codeCheckBlocksAutoCompile(options.compilePreferences, options.hasCodeCheckErrors)
        || options.saveState !== "saved"
        || !isPdfStale
        || isCompiling
        || options.manuscriptId === undefined
        || toolchain?.available !== true
        || lastCompileAttemptRevisionRef.current === sourceRevisionRef.current) {
      return;
    }
    const timeout = window.setTimeout(() => void start(), 500);
    return () => window.clearTimeout(timeout);
  }, [isCompiling, isPdfStale, options.autoCompile, options.compilePreferences?.codeCheck, options.hasCodeCheckErrors, options.manuscriptId, options.saveState, start, toolchain?.available]);

  return {
    cancel,
    engine,
    isCompiling,
    isPdfStale,
    markSourceChanged,
    pdfBytes,
    run,
    setEngine,
    start,
    pdfRun,
    toolchain,
  };
}
