// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CompileRun, SynctexPdfLocation } from "@research-assistant/writing";
import { browserWritingGateway } from "./gateway/browserWritingGateway";
import { useWritingSynctex } from "./useWritingSynctex";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const run: CompileRun = { id: "run-1", manuscriptId: "manuscript", status: "succeeded", engine: "pdflatex", artifacts: [{ kind: "synctex", byteSize: 10 }], diagnostics: [], rawOutput: "" };
const match = { page: 2, x: 30, y: 100, width: 20, height: 10 };
let sync!: ReturnType<typeof useWritingSynctex>;
let root: Root;
function Harness(props: Parameters<typeof useWritingSynctex>[0]) { sync = useWritingSynctex(props); return null; }
function options() {
  return { displayedPdfRevision: run.id, manuscriptId: "manuscript", run, toolchain: { available: true, tools: [{ name: "synctex", available: true }], supportedEngines: [], checkedAt: "" }, stale: false, hasPdf: true, enabled: true, activePath: "sections/body.tex", content: "First line\nSecond line", cursorOffset: 14, gateway: { ...browserWritingGateway, forwardSynctex: vi.fn(async () => [match]), inverseSynctex: vi.fn(async () => [{ relativePath: "sections/body.tex", line: 2 }]) }, onSource: vi.fn(async () => undefined), onPdf: vi.fn(), onError: vi.fn() } satisfies ComponentProps<typeof Harness>;
}
async function render(props: ComponentProps<typeof Harness>) {
  if (!root) { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  await act(async () => root.render(<Harness {...props} />));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); root = undefined as unknown as Root; document.body.replaceChildren(); });

it("uses the source cursor and the PDF reading point for both directions", async () => {
  const props = options(); await render(props);
  await act(async () => sync.actions.forward());
  expect(props.gateway.forwardSynctex).toHaveBeenCalledWith("run-1", "sections/body.tex", 2, 3);
  expect(sync.location).toMatchObject(match); expect(props.onPdf).toHaveBeenCalledOnce();
  await act(async () => sync.onReadingPosition({ key: "manuscript", revision: run.id, page: 2, x: 100, y: 140 }));
  await act(async () => sync.actions.backward());
  expect(props.gateway.inverseSynctex).toHaveBeenCalledWith("run-1", 2, 100, 140);
  expect(props.onSource).toHaveBeenCalledWith({ relativePath: "sections/body.tex", line: 2 }, expect.any(Function));
});

it("ignores outdated replies and rejects duplicate requests", async () => {
  let finish!: (value: SynctexPdfLocation[]) => void;
  const props = options();
  props.gateway.forwardSynctex = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  await render(props);
  await act(async () => { sync.actions.forward(); sync.actions.forward(); });
  expect(props.gateway.forwardSynctex).toHaveBeenCalledOnce();
  expect(sync.actions.forwardDisabled).toContain("正在定位");
  await render({ ...props, run: { ...run, id: "run-2" } });
  await act(async () => finish([match]));
  expect(props.onPdf).not.toHaveBeenCalled(); expect(sync.location).toBeUndefined();
});

it("reports empty results and disables unavailable or stale SyncTeX", async () => {
  const props = options(); props.gateway.forwardSynctex = vi.fn(async () => []);
  await render(props); await act(async () => sync.actions.forward());
  expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("没有找到"));
  await render({ ...props, stale: true });
  expect(sync.actions.backwardDisabled).toContain("源码已修改");
  await render({ ...props, run: { ...run, artifacts: [] } });
  expect(sync.actions.forwardDisabled).toContain("SyncTeX");
});

it("invalidates the reading point when the manuscript changes", async () => {
  const props = options(); await render(props);
  await act(async () => sync.onReadingPosition({ key: "manuscript", revision: run.id, page: 1, x: 2, y: 3 }));
  expect(sync.actions.backwardDisabled).toBeUndefined();
  await render({ ...props, manuscriptId: "other", displayedPdfRevision: "other-run", run: { ...run, manuscriptId: "other", id: "other-run" } });
  expect(sync.actions.backwardDisabled).toContain("查看 PDF");
});

it("invalidates a reading point from an older compile result", async () => {
  const props = options(); await render(props);
  await act(async () => sync.onReadingPosition({ key: "manuscript", revision: run.id, page: 1, x: 2, y: 3 }));
  expect(sync.actions.backwardDisabled).toBeUndefined();
  await render({ ...props, displayedPdfRevision: "run-2", run: { ...run, id: "run-2" } });
  expect(sync.actions.backwardDisabled).toContain("查看 PDF");
});

it("invalidates a cross-file navigation while its file read is pending", async () => {
  let isCurrent!: () => boolean;
  let finish!: () => void;
  const props: ComponentProps<typeof Harness> = {
    ...options(),
    onSource: async (_location, guard) => {
      isCurrent = guard;
      await new Promise<void>((resolve) => { finish = resolve; });
    },
  };
  await render(props);
  await act(async () => sync.inverse(2, 100, 140));
  expect(isCurrent()).toBe(true);
  await render({ ...props, stale: true });
  expect(isCurrent()).toBe(false);
  await act(async () => finish());
  expect(sync.actions.backwardDisabled).toContain("源码已修改");
});
