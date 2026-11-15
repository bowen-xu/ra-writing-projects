// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {createWritingNote, decodeWritingNote, type WritingNoteAsset, type WritingNoteFileV1} from "@research-assistant/writing";
import {editorToBlocks} from "@research-assistant/core/notes";
import WritingNoteEditor from "./WritingNoteEditor";
import {WritingNoteActivity} from "./WritingNoteActivity";
import type {WritingNoteEditor as Editor} from "./writingNoteSchema";

const ports = vi.hoisted(() => ({importAsset: vi.fn(), readAsset: vi.fn(), exportAsset: vi.fn(), editor: undefined as unknown}));
vi.mock("./writingNoteAssets", () => ({importWritingNoteAsset: ports.importAsset, readWritingNoteAsset: ports.readAsset, exportWritingNoteAsset: ports.exportAsset}));
vi.mock("@blocknote/react", async importOriginal => {
  const actual = await importOriginal<typeof import("@blocknote/react")>();
  return {...actual, useCreateBlockNote: (options: Parameters<typeof actual.useCreateBlockNote>[0]) => {
    const editor = actual.useCreateBlockNote(options); ports.editor = editor; return editor;
  }};
});
vi.hoisted(() => {
  if (!document.doctype) document.insertBefore(document.implementation.createDocumentType("html", "", ""), document.documentElement);
  Object.defineProperty(document, "compatMode", {configurable: true, value: "CSS1Compat"});
});
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII="), c => c.charCodeAt(0));
const asset = (displayName: string): WritingNoteAsset => ({assetId: displayName.replace(/\./gu, "-"), displayName, mimeType: "image/png"});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();});
function image(name = "image.png") {
  const file = new File([png], name, {type: "image/png"});
  Object.defineProperty(file, "arrayBuffer", {value: async () => png.slice().buffer});
  return file;
}
function fileTransfer(files: readonly File[]) {
  return {types: ["Files"], files, items: files.map(file => ({kind: "file", type: file.type, getAsFile: () => file})), getData: () => "", effectAllowed: "copy"};
}
async function setup(importer?: (manuscriptId: string, file: File) => Promise<WritingNoteAsset>, saved?: WritingNoteFileV1) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ports.importAsset.mockImplementation(importer ?? (async (_: string, file: File) => asset(file.name)));
  ports.readAsset.mockResolvedValue(png.slice());
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:writing-note-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const initial = JSON.stringify(saved ?? createWritingNote("writing-note", "text"));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const onChange = vi.fn(), finish = vi.fn(), begin = vi.fn(() => finish), invalid = vi.fn();
  const activity = {begin, invalid}; let alive = true;
  const render = async (readOnly = false) => {
    await act(async () => root.render(<WritingNoteActivity.Provider value={activity}>
      <WritingNoteEditor manuscriptId="manuscript" content={initial} readOnly={readOnly} onChange={onChange}/>
    </WritingNoteActivity.Provider>));
    await act(async () => {await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));});
  };
  const unmount = async () => {if (alive) {await act(async () => root.unmount()); alive = false;}};
  cleanups.push(async () => {await unmount(); host.remove();});
  await render();
  const editor = ports.editor as Editor;
  return {host, editor, onChange, finish, begin, render, unmount,
    document: () => decodeWritingNote(JSON.stringify({schemaVersion: 1, noteId: "writing-note", blocks: editorToBlocks(editor.document)})),
    async paste(files: readonly File[]) {
      const event = new Event("paste", {bubbles: true, cancelable: true});
      Object.defineProperty(event, "clipboardData", {value: fileTransfer(files)});
      await act(async () => {editor.domElement!.dispatchEvent(event);});
    },
  };
}

it("pastes every screenshot in clipboard order using manuscript-owned assets and blob previews", async () => {
  const f = await setup(); await f.paste([image("first.png"), image("second.png")]);
  await vi.waitFor(() => expect(ports.importAsset).toHaveBeenCalledTimes(2));
  await act(async () => {await Promise.resolve();});
  expect(ports.importAsset.mock.calls.map(([id]) => id)).toEqual(["manuscript", "manuscript"]);
  const images = f.document().blocks.filter(block => block.content.kind === "asset");
  expect(images.map(block => block.content.kind === "asset" && block.content.displayName)).toEqual(["first.png", "second.png"]);
  expect(images.every(block => block.content.kind === "asset" && block.content.mimeType === "image/png")).toBe(true);
  expect(f.editor.document.filter(block => block.type === "managedImage")).toHaveLength(2);
  expect([...f.host.querySelectorAll(".writing-note-asset img")].map(node => node.getAttribute("src"))).toEqual(["blob:writing-note-image", "blob:writing-note-image"]);
  expect(f.begin).toHaveBeenCalledOnce(); expect(f.finish).toHaveBeenCalledOnce();
});

it("preserves editable text during an upload and never publishes an unresolved image placeholder", async () => {
  let finish!: (value: WritingNoteAsset) => void;
  const f = await setup(() => new Promise(resolve => {finish = resolve;}));
  await f.paste([image()]); await vi.waitFor(() => expect(ports.importAsset).toHaveBeenCalledOnce());
  await act(async () => {f.editor.updateBlock("text", {content: "Text entered during import"});});
  expect(f.document().blocks.some(block => block.content.kind === "asset")).toBe(false);
  for (const [raw] of f.onChange.mock.calls) expect(decodeWritingNote(raw as string).blocks.some(block => block.content.kind === "asset")).toBe(false);
  await act(async () => {finish(asset("image.png"));});
  const saved = f.document();
  expect(saved.blocks[0]!.content).toEqual({kind: "inline", items: [{type: "text", text: "Text entered during import", styles: []}]});
  expect(saved.blocks[1]?.content).toEqual({kind: "asset", ...asset("image.png"), caption: ""});
  expect(f.finish).toHaveBeenCalledOnce();
});

it.each(["readonly", "unmounted", "removed-anchor"] as const)("does not insert the completed image after %s", async state => {
  let finish!: (value: WritingNoteAsset) => void;
  const f = await setup(() => new Promise(resolve => {finish = resolve;}));
  await f.paste([image()]); await vi.waitFor(() => expect(ports.importAsset).toHaveBeenCalledOnce());
  if (state === "readonly") await f.render(true);
  else if (state === "unmounted") await f.unmount();
  else await act(async () => {f.editor.removeBlocks(["text"]);});
  const insert = vi.spyOn(f.editor, "insertBlocks"), update = vi.spyOn(f.editor, "updateBlock");
  await act(async () => {finish(asset("image.png"));});
  expect(insert).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  expect(f.document().blocks.some(block => block.content.kind === "asset")).toBe(false);
  expect(f.finish).toHaveBeenCalledOnce();
});

it("leaves the document unchanged and releases the activity guard when an image import fails", async () => {
  const f = await setup(async () => {throw new Error("writing image disk failure");});
  const before = f.document(); await f.paste([image()]);
  await vi.waitFor(() => expect(f.host.textContent).toContain("writing image disk failure"));
  expect(f.document()).toEqual(before); expect(f.host.querySelector("img")).toBeNull();
  expect(f.finish).toHaveBeenCalledOnce();
});

it("drops the image next to the targeted block, independently of the old cursor", async () => {
  const f = await setup();
  await act(async () => {
    f.editor.updateBlock("text", {content: "First"});
    f.editor.insertBlocks([{id: "drop-target", type: "paragraph", content: "Target"}, {id: "after-target", type: "paragraph", content: "After"}], "text", "after");
    f.editor.setTextCursorPosition("text", "start");
  });
  let position = 0;
  f.editor.prosemirrorView.state.doc.descendants((node, pos) => {if (node.attrs.id === "drop-target") position = pos + 2;});
  vi.spyOn(f.editor.prosemirrorView, "posAtCoords").mockReturnValue({pos: position, inside: -1});
  // Give BlockNote's document-level drop owner real enclosing geometry; the
  // happy-dom default is an empty rectangle and would clamp the event to 0,0.
  vi.spyOn(f.editor.domElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 600));
  vi.spyOn(f.editor.domElement!.firstElementChild!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 600));
  const target = f.host.querySelector<HTMLElement>('[data-id="drop-target"]')!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 40));
  const event = new Event("drop", {bubbles: true, cancelable: true});
  Object.defineProperties(event, {dataTransfer: {value: fileTransfer([image("dropped.png")])}, clientX: {value: 100}, clientY: {value: 135}});
  await act(async () => {target.dispatchEvent(event);});
  await vi.waitFor(() => expect(ports.importAsset).toHaveBeenCalledOnce());
  const blocks = f.editor.document, inserted = blocks.find(block => block.type === "managedImage");
  expect(inserted).toBeDefined();
  expect(blocks.findIndex(block => block.id === inserted!.id)).toBe(blocks.findIndex(block => block.id === "drop-target") + 1);
  expect(blocks.findIndex(block => block.id === "after-target")).toBe(blocks.findIndex(block => block.id === inserted!.id) + 1);
});

it("uses the managed image path for file-picker uploads as well", async () => {
  const f = await setup(), input = f.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {configurable: true, value: [image("picked.png")]});
  await act(async () => {input.dispatchEvent(new Event("change", {bubbles: true}));});
  await vi.waitFor(() => expect(ports.importAsset).toHaveBeenCalledOnce());
  expect(f.document().blocks.find(block => block.content.kind === "asset")?.content).toEqual({kind: "asset", ...asset("picked.png"), caption: ""});
  expect(f.host.querySelector(".writing-note-asset img")?.getAttribute("src")).toBe("blob:writing-note-image");
});
