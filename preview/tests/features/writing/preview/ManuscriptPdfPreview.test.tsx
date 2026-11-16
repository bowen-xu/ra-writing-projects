// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PdfViewOpenInput } from "@research-assistant/workbench-preview/pdf-view-adapter";
import { ManuscriptPdfPreview } from "@research-assistant/writing-projects-preview/manuscript-pdf-preview";

const fixture = vi.hoisted(() => ({ inputs: [] as PdfViewOpenInput[], active: vi.fn(), close: vi.fn() }));
vi.mock("@research-assistant/workbench-preview/pdf-view-adapter", () => ({ PdfViewAdapter: class {
  characterStore = {}; open(input: PdfViewOpenInput) { fixture.inputs.push(input); return Promise.resolve(); }
  close = fixture.close; setActive = fixture.active; suspend() {} readingPoint() { return { pageIndex: 1, x: 100, y: 600, pageBox: [0, 0, 612, 792] }; }
  focus() {} updateScaleAt() {} find() {} closeFind() {}
} }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); fixture.inputs.length = 0; vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function ready(index: number) {
  fixture.inputs[index]!.callbacks.onReady({ pageCount: 2, pageIndex: 1, pageLabels: [], scale: 1, viewState: { pageIndex: 1, scale: { kind: "page-width" }, scrollMode: "vertical", spreadMode: "none" } });
}
it("reports coordinates with the displayed compile identity, never a pending replacement", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  const report = vi.fn(), displayed = vi.fn();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const source = { key: "draft", revision: "one", bytes: new Uint8Array([1]) };
  const render = async (revision: string, active = true) => act(async () => root!.render(<ManuscriptPdfPreview source={{ ...source, revision }} active={active} onDisplayedVersion={displayed} onReadingPosition={report} onInverseSearch={vi.fn()} />));
  await render("one"); expect(report).not.toHaveBeenCalled();
  await act(async () => ready(0));
  expect(report).toHaveBeenLastCalledWith({ key: "draft", revision: "one", page: 2, x: 100, y: 192 });
  report.mockClear(); await render("two");
  expect(displayed).toHaveBeenLastCalledWith(undefined);
  expect(report).not.toHaveBeenCalled();
  expect(fixture.inputs[1]?.preserveView).toBe(true);
  await act(async () => ready(1));
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "two" }));
  await render("two", false);
  expect(fixture.inputs).toHaveLength(2);
  expect(fixture.active).toHaveBeenLastCalledWith(false);
});

it("does not feed a render-created reading callback back into the parent", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  const report = vi.fn();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const source = { key: "draft", revision: "one", bytes: new Uint8Array([1]) };
  const render = async () => act(async () => root!.render(
    <ManuscriptPdfPreview source={source} active onReadingPosition={() => report()} onInverseSearch={vi.fn()} />,
  ));
  await render();
  await act(async () => ready(0));
  expect(report).toHaveBeenCalledOnce();
  await render();
  expect(report).toHaveBeenCalledOnce();
  const latestReport = vi.fn();
  await act(async () => root!.render(
    <ManuscriptPdfPreview source={source} active onReadingPosition={latestReport} onInverseSearch={vi.fn()} />,
  ));
  expect(latestReport).not.toHaveBeenCalled();
  await act(async () => fixture.inputs[0]!.callbacks.onViewAreaChange({ viewState: {
    pageIndex: 0, scale: { kind: "page-width" }, scrollMode: "vertical", spreadMode: "none",
  } }));
  expect(latestReport).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
});
