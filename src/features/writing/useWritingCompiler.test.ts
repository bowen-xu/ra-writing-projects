import type { CompileRun } from "@research-assistant/writing";
import { describe, expect, it, vi } from "vitest";

import { applyCompilePollResult, codeCheckBlocksAutoCompile, startCompileAfterSave } from "./useWritingCompiler";

const queuedRun: CompileRun = {
  artifacts: [],
  diagnostics: [],
  engine: "pdflatex",
  id: "run",
  manuscriptId: "manuscript",
  rawOutput: "",
  status: "queued",
};

describe("startCompileAfterSave", () => {
  it("does not compile when saving reports a conflict or failure", async () => {
    const startCompile = vi.fn(async () => queuedRun);
    await startCompileAfterSave({
      cancelCompile: vi.fn(), isCancelled: () => false, onPreparing: vi.fn(),
      onRun: vi.fn(), saveCurrent: async () => false, startCompile,
    });
    expect(startCompile).not.toHaveBeenCalled();
  });

  it("reports preparation synchronously and waits for the latest save", async () => {
    const events: string[] = [];
    let releaseSave: ((value: boolean) => void) | undefined;
    const save = new Promise<boolean>((resolve) => { releaseSave = resolve; });
    const startCompile = vi.fn(async () => {
      events.push("compile");
      return queuedRun;
    });

    const operation = startCompileAfterSave({
      cancelCompile: vi.fn(),
      isCancelled: () => false,
      onPreparing: () => { events.push("preparing"); },
      onRun: () => { events.push("queued"); },
      saveCurrent: () => save,
      startCompile,
    });

    expect(events).toEqual(["preparing"]);
    expect(startCompile).not.toHaveBeenCalled();
    releaseSave?.(true);
    await operation;
    expect(events).toEqual(["preparing", "compile", "queued"]);
  });

  it("cancels a backend run when cancellation arrives during startup", async () => {
    let cancelled = false;
    let releaseStart: ((value: CompileRun) => void) | undefined;
    const backendStart = new Promise<CompileRun>((resolve) => { releaseStart = resolve; });
    const cancelCompile = vi.fn(async () => undefined);
    const onRun = vi.fn();
    const operation = startCompileAfterSave({
      cancelCompile,
      isCancelled: () => cancelled,
      onPreparing: vi.fn(),
      onRun,
      saveCurrent: async () => true,
      startCompile: () => backendStart,
    });
    await Promise.resolve();
    cancelled = true;
    releaseStart?.(queuedRun);

    await operation;
    expect(cancelCompile).toHaveBeenCalledWith("run");
    expect(onRun).not.toHaveBeenCalled();
  });
});

describe("applyCompilePollResult", () => {
  it("publishes a PDF from a failed run without hiding its errors", async () => {
    const run: CompileRun = { ...queuedRun, status: "failed", artifacts: [{ kind: "pdf", byteSize: 10 }], diagnostics: [{ severity: "error", message: "BibTeX failed" }] };
    const onPdfReady = vi.fn();
    const onTerminal = vi.fn();
    await applyCompilePollResult(run, {
      isCurrent: async () => false, onActive: vi.fn(), onPdfReady, onTerminal,
      readPdf: async () => new Uint8Array([37]),
    });
    expect(onPdfReady).toHaveBeenCalledWith(run, new Uint8Array([37]), false);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "timedOut"] as const)("keeps the previous PDF when %s has no usable output", async (status) => {
    const run: CompileRun = { ...queuedRun, status };
    const readPdf = vi.fn();
    const onTerminal = vi.fn();
    await applyCompilePollResult(run, {
      isCurrent: async () => true, onActive: vi.fn(), onPdfReady: vi.fn(), onTerminal, readPdf,
    });
    expect(readPdf).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith(run);
  });

  it("loads the new PDF before publishing a successful run", async () => {
    let releasePdf: ((value: Uint8Array) => void) | undefined;
    const pdf = new Promise<Uint8Array>((resolve) => { releasePdf = resolve; });
    const onPdfReady = vi.fn();
    const completedRun: CompileRun = { ...queuedRun, status: "succeeded" };

    const operation = applyCompilePollResult(completedRun, {
      isCurrent: async () => true,
      onActive: vi.fn(),
      onPdfReady,
      onTerminal: vi.fn(),
      readPdf: () => pdf,
    });

    await Promise.resolve();
    expect(onPdfReady).not.toHaveBeenCalled();
    releasePdf?.(new Uint8Array([37, 80, 68, 70]));
    await expect(operation).resolves.toBe(false);
    expect(onPdfReady).toHaveBeenCalledWith(
      completedRun,
      new Uint8Array([37, 80, 68, 70]),
      true,
    );
  });
});

describe("Code Check auto-compile gating", () => {
  it("blocks only automatic compilation while enabled findings are present", () => {
    expect(codeCheckBlocksAutoCompile(undefined, true)).toBe(true);
    expect(codeCheckBlocksAutoCompile({ draft: false, codeCheck: false, stopOnFirstError: false }, true)).toBe(false);
    expect(codeCheckBlocksAutoCompile({ draft: false, codeCheck: true, stopOnFirstError: false }, false)).toBe(false);
  });
});
