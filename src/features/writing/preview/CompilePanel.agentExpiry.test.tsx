// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentCompileResult } from "@research-assistant/core/agent";

const { notifyInfo } = vi.hoisted(() => ({ notifyInfo: vi.fn() }));

vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({ notify: { info: notifyInfo, error: vi.fn() } }));
vi.mock("./CompileOptionsMenu", () => ({ CompileOptionsMenu: () => <span /> }));
vi.mock("./PreviewMenu", () => ({ PreviewMenu: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../WritingMenu", () => ({ WritingMenuItem: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button> }));
vi.mock("../WritingDivider", () => ({ WritingSyncButton: () => <span /> }));
vi.mock("./ManuscriptPdfPreview", () => ({ ManuscriptPdfPreview: ({ source }: { source: { documentId: string } }) => <div data-testid="pdf-source">{source.documentId}</div> }));

import { CompilePanel } from "./CompilePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  notifyInfo.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function result(expiresAfterSeconds: number): AgentCompileResult {
  const id = "11111111-1111-4111-8111-111111111111";
  return {
    status: "succeeded",
    resultId: "22222222-2222-4222-8222-222222222222",
    compileVersion: "22222222-2222-4222-8222-222222222222",
    identity: { conversationId: id, requestId: id, turnId: id, contextSnapshotId: id, manuscriptId: id, leaseId: id, manifestHash: "a".repeat(64) },
    rootPath: "main.tex",
    exitCode: 0,
    diagnostics: [],
    artifacts: { pdf: true, synctex: true },
    retained: true,
    createdAtUnixSeconds: 100,
    expiresAfterSeconds,
  };
}

function props(agentCompileResult: AgentCompileResult, loadAgentPdf: NonNullable<ComponentProps<typeof CompilePanel>["loadAgentPdf"]>): ComponentProps<typeof CompilePanel> {
  return {
    compilePreferences: { draft: false, codeCheck: true, stopOnFirstError: false },
    onCompilePreferencesChange: vi.fn(), onCompileFromScratch: vi.fn(), isCompiling: false,
    toolchain: { available: false, tools: [], supportedEngines: [], checkedAt: "2026-01-01T00:00:00Z" },
    run: undefined, active: true, pdfIdentity: undefined, onDisplayedVersion: vi.fn(), pdfBytes: undefined,
    onCompile: vi.fn(), onCancel: vi.fn(), autoCompile: false, onAutoCompileChange: vi.fn(), isPdfStale: false,
    syncActions: { forward: vi.fn(), backward: vi.fn(), forwardDisabled: "disabled", backwardDisabled: "disabled" },
    onReadingPosition: vi.fn(), onOpenDiagnostic: vi.fn(), synctexLocation: undefined, onInverseSearch: vi.fn(),
    agentCompileResult, loadAgentPdf,
  };
}

it("removes an unopened Agent PDF entry when its retained result expires", async () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<CompilePanel {...props(result(1), vi.fn())} />));
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Agent PDF")).toBe(true);

  await act(async () => vi.advanceTimersByTimeAsync(1_000));

  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Agent PDF")).toBe(false);
  expect(notifyInfo).not.toHaveBeenCalled();
});

it("drops an open Agent PDF and ignores a late load after expiry", async () => {
  let resolveLoad!: (value: { documentId: string; revision: string; key: string; bytes: Uint8Array }) => void;
  const load = vi.fn(() => new Promise<{ documentId: string; revision: string; key: string; bytes: Uint8Array }>((resolve) => { resolveLoad = resolve; }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<CompilePanel {...props(result(1), load)} />));
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Agent PDF")!;
  await act(async () => button.click());

  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  await act(async () => resolveLoad({ documentId: "late-agent-pdf", revision: "late-agent-pdf", key: "late-agent-pdf", bytes: new Uint8Array([1]) }));

  expect(host.querySelector('[data-testid="pdf-source"]')).toBeNull();
  expect([...host.querySelectorAll("button")].some((candidate) => candidate.textContent === "Agent PDF")).toBe(false);
  expect(notifyInfo).toHaveBeenCalledWith("Agent 临时 PDF 已过期，请重新编译后再打开。");
});

it("drops the previous Agent PDF when a newer compile result arrives", async () => {
  const oldSource = { documentId: "old-agent-pdf", revision: "old-agent-pdf", key: "old-agent-pdf", bytes: new Uint8Array([1]) };
  const newSource = { documentId: "new-agent-pdf", revision: "new-agent-pdf", key: "new-agent-pdf", bytes: new Uint8Array([2]) };
  const load = vi.fn()
    .mockResolvedValueOnce(oldSource)
    .mockResolvedValueOnce(newSource);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const first = result(60);
  await act(async () => root?.render(<CompilePanel {...props(first, load)} />));
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Agent PDF")!;
  await act(async () => button.click());
  expect(host.querySelector('[data-testid="pdf-source"]')?.textContent).toBe("old-agent-pdf");

  const second = { ...result(60), resultId: "33333333-3333-4333-8333-333333333333", compileVersion: "33333333-3333-4333-8333-333333333333" };
  await act(async () => root?.render(<CompilePanel {...props(second, load)} />));
  expect(host.querySelector('[data-testid="pdf-source"]')).toBeNull();
  expect([...host.querySelectorAll("button")].some((candidate) => candidate.textContent === "Agent PDF")).toBe(true);

  const nextButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Agent PDF")!;
  await act(async () => nextButton.click());
  expect(host.querySelector('[data-testid="pdf-source"]')?.textContent).toBe("new-agent-pdf");
});
