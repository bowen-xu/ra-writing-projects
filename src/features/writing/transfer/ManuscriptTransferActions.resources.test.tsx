// @vitest-environment happy-dom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {open} from "@research-assistant/workbench-sdk/platform";
import type {Manuscript} from "@research-assistant/writing";
import type {WritingGateway} from "../gateway";
import {WritingMenu} from "../WritingMenu";
import {ManuscriptTransferActions} from "./ManuscriptTransferActions";

vi.mock("@research-assistant/workbench-sdk/platform", () => ({open: vi.fn()}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.resetAllMocks();
});

async function mount() {
  const importResources = vi.fn(async () => ({importedPaths: ["figures/source.bib"], byteSize: 100}));
  const onError = vi.fn(), onResourcesImported = vi.fn();
  const gateway = {supportsCompilation: true, importResources} as unknown as WritingGateway;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <WritingMenu label="文件" trigger="文件" className="writing-menu" showTitle={false}>
      <ManuscriptTransferActions variant="imports" activeManuscript={{id: "original-manuscript"} as Manuscript}
        gateway={gateway} hasPdf={false} onError={onError} onImported={vi.fn()}
        onResourcesImported={onResourcesImported} />
    </WritingMenu>,
  ));
  return {importResources, onError, onResourcesImported};
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === text);
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
async function pick() {
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="文件"]')!.click());
  await act(async () => button("上传资源").click());
}
function dialog(): HTMLElement {
  const result = document.querySelector<HTMLElement>('[role="dialog"][aria-label="上传资源目录"]');
  if (!result) throw new Error("Missing resource directory dialog");
  return result;
}
async function directory(value: string) {
  const input = dialog().querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
}

it("retains the follow-up Core dialog after its production menu closes and confirms once", async () => {
  const actions = await mount();
  vi.mocked(open).mockResolvedValueOnce(["/synthetic/source.bib", "/synthetic/chapter.tex"]);
  await pick();
  const surface = dialog();
  expect(surface.hasAttribute("data-overlay-surface")).toBe(true);
  expect(surface.querySelector<HTMLInputElement>("input")!.value).toBe("figures");
  expect(document.querySelector('button[aria-label="文件"]')!.getAttribute("aria-expanded")).toBe("false");
  expect(actions.importResources).not.toHaveBeenCalled();
  await act(async () => {
    surface.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
    surface.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
  });
  expect(actions.importResources).toHaveBeenCalledExactlyOnceWith("original-manuscript", "figures", ["/synthetic/source.bib", "/synthetic/chapter.tex"]);
  expect(actions.onResourcesImported).toHaveBeenCalledOnce();
  expect(actions.onError).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="上传资源目录"]')).toBeNull();
});

it("trims the confirmed directory and prevents an empty submission", async () => {
  const actions = await mount();
  vi.mocked(open).mockResolvedValueOnce("/synthetic/source.bib");
  await pick();
  await directory("   ");
  expect(button("上传", dialog()).disabled).toBe(true);
  await act(async () => dialog().querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  expect(actions.importResources).not.toHaveBeenCalled();
  await directory("  bibliography  ");
  await act(async () => button("上传", dialog()).click());
  expect(actions.importResources).toHaveBeenCalledExactlyOnceWith("original-manuscript", "bibliography", ["/synthetic/source.bib"]);
});

it("cancels without uploading and restores the original default on the next choice", async () => {
  const actions = await mount();
  vi.mocked(open).mockResolvedValue(["/synthetic/source.bib"]);
  await pick();
  await directory("other");
  await act(async () => button("取消", dialog()).click());
  expect(actions.importResources).not.toHaveBeenCalled();
  expect(actions.onResourcesImported).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="上传资源目录"]')).toBeNull();
  await pick();
  expect(dialog().querySelector<HTMLInputElement>("input")!.value).toBe("figures");
});

it("dismisses the shared input with Escape without uploading", async () => {
  const actions = await mount();
  vi.mocked(open).mockResolvedValue(["/synthetic/source.bib"]);
  await pick();
  await act(async () => dialog().dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true})));
  await vi.waitFor(() => expect(document.querySelector('[aria-label="上传资源目录"]')).toBeNull());
  expect(actions.importResources).not.toHaveBeenCalled();
});

it("does not open a directory input or upload after the native picker is cancelled", async () => {
  const actions = await mount();
  vi.mocked(open).mockResolvedValueOnce(null);
  await pick();
  expect(document.querySelector('[aria-label="上传资源目录"]')).toBeNull();
  expect(actions.importResources).not.toHaveBeenCalled();
  expect(actions.onError).not.toHaveBeenCalled();
});

it("retains picker errors and does not admit an upload", async () => {
  const actions = await mount();
  vi.mocked(open).mockRejectedValueOnce({code: "picker_failed", message: "picker_failed request=synthetic"});
  await pick();
  expect(actions.onError).toHaveBeenCalledExactlyOnceWith("picker_failed request=synthetic");
  expect(actions.importResources).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="上传资源目录"]')).toBeNull();
});

it("preserves upload errors and allows the original explicit selection to retry", async () => {
  const actions = await mount();
  vi.mocked(open).mockResolvedValue(["/synthetic/source.bib"]);
  actions.importResources.mockRejectedValueOnce({code: "storage_error", message: "storage_error operation=synthetic"});
  await pick();
  await act(async () => button("上传", dialog()).click());
  expect(actions.onError).toHaveBeenCalledExactlyOnceWith("storage_error operation=synthetic");
  expect(actions.onResourcesImported).not.toHaveBeenCalled();
  await pick();
  await act(async () => button("上传", dialog()).click());
  expect(actions.importResources).toHaveBeenCalledTimes(2);
  expect(actions.onResourcesImported).toHaveBeenCalledOnce();
});
