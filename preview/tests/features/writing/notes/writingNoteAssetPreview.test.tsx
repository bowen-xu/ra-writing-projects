// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {BlockNoteEditor} from "@blocknote/core";
import {afterEach, expect, it, vi} from "vitest";
import {NoteEditorSurface} from "@research-assistant/workbench-preview/block-content";
import {writingNoteSchema, WritingNoteOwner, type WritingNoteEditor} from "@research-assistant/writing-projects-preview/writing-note-schema";

const ports = vi.hoisted(() => ({read: vi.fn(), commits: [] as {src: string | undefined; error: string | undefined}[]}));
vi.mock("@research-assistant/writing-projects-preview/writing-note-assets", () => ({readWritingNoteAsset: ports.read, exportWritingNoteAsset: vi.fn()}));
vi.mock("@research-assistant/workbench-preview/image-block-presentation", async importOriginal => {
  const actual = await importOriginal<typeof import("@research-assistant/workbench-preview/image-block-presentation")>();
  const React = await import("react");
  // Keep the production UI, observing every child commit before passive asset
  // effects can hide an incorrectly exposed previous owner's image or error.
  return {...actual, ImageBlockPresentation: (props: Parameters<typeof actual.ImageBlockPresentation>[0]) => {
    React.useLayoutEffect(() => {ports.commits.push({src: props.src, error: props.error});});
    return React.createElement(actual.ImageBlockPresentation, props);
  }};
});
vi.hoisted(() => {
  if (!document.doctype) document.insertBefore(document.implementation.createDocumentType("html", "", ""), document.documentElement);
  Object.defineProperty(document, "compatMode", {configurable: true, value: "CSS1Compat"});
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  ports.commits.length = 0; ports.read.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function pending() {
  let resolve!: (bytes: Uint8Array) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<Uint8Array>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
async function setup(read: (owner: string, id: string) => Promise<Uint8Array>, initialOwner: string | undefined = "owner-a") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); ports.read.mockImplementation(read);
  let nextUrl = 0;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:writing-preview-${++nextUrl}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const editor = BlockNoteEditor.create({schema: writingNoteSchema, initialContent: [{id: "image", type: "managedImage",
    props: {assetId: "asset-a", displayName: "asset-a.png", mimeType: "image/png", caption: ""},
  }]}) as unknown as WritingNoteEditor;
  let mounted = true;
  const render = async (owner: string | undefined) => {
    await act(async () => root.render(<WritingNoteOwner.Provider value={owner}>
      <NoteEditorSurface editor={editor} onChange={() => undefined} />
    </WritingNoteOwner.Provider>));
  };
  const stop = async () => {if (mounted) {await act(async () => root.unmount()); mounted = false;}};
  cleanups.push(async () => {await stop(); host.remove();});
  await render(initialOwner);
  return {host, editor, render, stop, create, revoke};
}

it("hides the previous image in the first asset-ID render and revokes its object URL", async () => {
  const second = pending();
  const f = await setup(async (_owner, id) => id === "asset-a" ? Uint8Array.of(1) : second.promise);
  expect(f.host.querySelector("img")?.getAttribute("src")).toBe("blob:writing-preview-1");
  ports.commits.length = 0;
  await act(async () => f.editor.updateBlock("image", {props: {assetId: "asset-b"}}));
  expect(ports.commits[0]).toEqual({src: undefined, error: undefined});
  expect(f.host.querySelector("img")).toBeNull(); expect(f.revoke).toHaveBeenCalledExactlyOnceWith("blob:writing-preview-1");
  await act(async () => second.resolve(Uint8Array.of(2)));
  expect(f.host.querySelector("img")?.getAttribute("src")).toBe("blob:writing-preview-2");
  await f.stop(); expect(f.revoke.mock.calls).toEqual([["blob:writing-preview-1"], ["blob:writing-preview-2"]]);
});

it.each(["success", "failure"] as const)("ignores a previous manuscript's late %s after changing owners", async result => {
  const first = pending(), second = pending();
  const f = await setup((owner) => owner === "owner-a" ? first.promise : second.promise);
  await f.render("owner-b");
  expect(ports.read).toHaveBeenLastCalledWith("owner-b", "asset-a");
  await act(async () => second.resolve(Uint8Array.of(2)));
  expect(f.host.querySelector("img")?.getAttribute("src")).toBe("blob:writing-preview-1");
  await act(async () => {
    if (result === "success") first.resolve(Uint8Array.of(1));
    else first.reject(Object.assign(new Error("旧稿件读取失败"), {code: "old_owner_error"}));
  });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.host.querySelector("img")?.getAttribute("src")).toBe("blob:writing-preview-1");
  expect(f.host.textContent).not.toContain("old_owner_error");
});

it("hides an already loaded previous manuscript image before starting the new read", async () => {
  const second = pending();
  const f = await setup(async owner => owner === "owner-a" ? Uint8Array.of(1) : second.promise);
  ports.commits.length = 0;
  await f.render("owner-b");
  expect(ports.commits[0]).toEqual({src: undefined, error: undefined});
  expect(f.host.querySelector("img")).toBeNull(); expect(f.revoke).toHaveBeenCalledExactlyOnceWith("blob:writing-preview-1");
});

it("treats MIME changes as a new preview identity", async () => {
  const second = pending(); let calls = 0;
  const f = await setup(async () => ++calls === 1 ? Uint8Array.of(1) : second.promise);
  ports.commits.length = 0;
  await act(async () => f.editor.updateBlock("image", {props: {mimeType: "image/jpeg"}}));
  expect(ports.commits[0]).toEqual({src: undefined, error: undefined});
  expect(f.host.querySelector("img")).toBeNull(); expect(f.revoke).toHaveBeenCalledExactlyOnceWith("blob:writing-preview-1");
});

it("preserves the safe read error code and cause and clears them immediately for a different asset", async () => {
  const second = pending();
  const f = await setup((_, id) => id === "asset-a"
    ? Promise.reject(Object.assign(new Error("附件记录字节无效，原记录已保留"), {code: "writing_note_asset_corrupt"})) : second.promise);
  const error = f.host.querySelector('[role="alert"]');
  expect(error?.textContent).toContain("writing_note_asset_read_failed");
  expect(error?.textContent).toContain("writing_note_asset_corrupt"); expect(error?.textContent).toContain("原记录已保留");
  expect(error?.textContent).not.toContain("附件缺失");
  ports.commits.length = 0;
  await act(async () => f.editor.updateBlock("image", {props: {assetId: "asset-b"}}));
  expect(ports.commits[0]).toEqual({src: undefined, error: undefined});
  expect(f.host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => second.resolve(Uint8Array.of(2)));
  expect(f.host.querySelector("img")).not.toBeNull();
});

it("reports a decode failure and releases its URL immediately and only once", async () => {
  const f = await setup(async () => Uint8Array.of(1));
  const image = f.host.querySelector("img"); expect(image).not.toBeNull();
  await act(async () => image?.dispatchEvent(new Event("error")));
  expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("writing_note_asset_decode_failed");
  expect(f.host.querySelector("img")).toBeNull(); expect(f.revoke).toHaveBeenCalledExactlyOnceWith("blob:writing-preview-1");
  await act(async () => image?.dispatchEvent(new Event("error")));
  await f.stop(); expect(f.revoke).toHaveBeenCalledOnce();
});

it("handles a synchronous resource-read failure without an unhandled rejection", async () => {
  const f = await setup(() => {throw Object.assign(new Error("本地读取失败 EIO"), {code: "storage_error"});});
  expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("storage_error");
  expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("EIO");
  expect(f.create).not.toHaveBeenCalled(); expect(f.revoke).not.toHaveBeenCalled();
});
