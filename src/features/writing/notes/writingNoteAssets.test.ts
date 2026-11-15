// @vitest-environment happy-dom
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {MAX_WRITING_NOTE_ASSET_BYTES} from "@research-assistant/writing";
import {getAppRuntime, selectAppRuntime, type AppRuntime} from "../../../../../../apps/web/src/core/runtime/appRuntime";
import {configurePreviewDatabase} from "../../../../../../apps/web/src/core/runtime/previewIndexedDatabase";
import {createIndexedPreviewStorage} from "../../../../../../apps/web/src/core/runtime/previewIndexedStorage";
import {createMemoryPreviewDatabase} from "../../../../../../apps/web/src/app/runtime/testing/memoryPreviewDatabase";
import {storagePersistence} from "../../../../../../apps/web/src/core/runtime/storagePersistence";
import type {WritingGateway} from "../gateway";
import {importWritingNoteAsset, readWritingNoteAsset} from "./writingNoteAssets";
import {getAppStorage} from "@research-assistant/workbench-sdk/storage";

const native = vi.hoisted(() => {
  const assets = {importAsset: vi.fn(), readAsset: vi.fn(), exportAsset: vi.fn()};
  return {invoke: vi.fn(), assets, getAssets: vi.fn(() => assets)};
});
vi.mock("@tauri-apps/api/core", () => ({isTauri: () => false, invoke: native.invoke}));
vi.mock("../../../../../../apps/web/src/core/public/writingRuntime", async () => ({
  ...await vi.importActual("../../../../../../apps/web/src/core/public/writingRuntime"),
  getWritingNoteAssetNativeGateway: native.getAssets,
}));
const bytes = Uint8Array.from([137, 80, 78, 71]);
let database: ReturnType<typeof createMemoryPreviewDatabase>, previous: AppRuntime;
beforeEach(() => {
  previous = getAppRuntime(); database = createMemoryPreviewDatabase(); configurePreviewDatabase(database.open);
  native.invoke.mockReset(); native.getAssets.mockClear();
  for (const method of Object.values(native.assets)) method.mockReset();
});
afterEach(() => {selectAppRuntime(previous); vi.restoreAllMocks();});
function imageFile() {
  const file = new File([bytes.buffer], "截图.png", {type: "image/png"});
  Object.defineProperty(file, "arrayBuffer", {value: async () => bytes.slice().buffer, configurable: true});
  return file;
}
function activate(storage: Storage, listFiles = vi.fn(async (_id: string) => [])) {
  const runtime: AppRuntime = {mode: "preview", storage, gateways: {getWritingGateway: {listFiles} as unknown as WritingGateway}, dispose() {}};
  selectAppRuntime(runtime);
  expect(getAppStorage()).toBe(runtime.storage);
  return {runtime, listFiles};
}
it("persists screenshot bytes before returning and recovers them after reopening the same scope", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-one:"); const owner = activate(storage);
  const asset = await importWritingNoteAsset("manuscript-a", imageFile());
  expect(owner.listFiles).toHaveBeenCalledWith("manuscript-a"); expect(asset).toMatchObject({displayName: `${asset.assetId}.png`, mimeType: "image/png"});
  expect(storage.getItem(storage.key(0)!)).not.toContain("截图.png");
  expect(database.metrics.commits).toBe(1);
  activate(await createIndexedPreviewStorage("writing-assets-one:"));
  const reopened = await readWritingNoteAsset("manuscript-a", asset.assetId);
  expect(reopened).toEqual(bytes); reopened[0] = 0;
  expect(await readWritingNoteAsset("manuscript-a", asset.assetId)).toEqual(bytes);
  expect(native.invoke).not.toHaveBeenCalled();
});
it("isolates asset identity by manuscript and preview storage owner", async () => {
  const first = await createIndexedPreviewStorage("writing-assets-one:"); activate(first);
  const asset = await importWritingNoteAsset("manuscript-a", imageFile());
  await expect(readWritingNoteAsset("manuscript-b", asset.assetId)).rejects.toThrow("附件不存在");
  activate(await createIndexedPreviewStorage("writing-assets-two:"));
  await expect(readWritingNoteAsset("manuscript-a", asset.assetId)).rejects.toThrow("附件不存在");
  activate(await createIndexedPreviewStorage("writing-assets-one:"));
  expect(await readWritingNoteAsset("manuscript-a", asset.assetId)).toEqual(bytes);
});
it("waits for the IndexedDB transaction receipt rather than acknowledging a staged value", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-wait:"); activate(storage);
  let release!: () => void; database.holdUntil(new Promise<void>(done => {release = done;}));
  let saved = false;
  const result = importWritingNoteAsset("manuscript-a", imageFile()).then(value => {saved = true; return value;});
  await vi.waitFor(() => expect(storagePersistence(storage)?.pending).toBe(true));
  expect(saved).toBe(false); release(); await result; expect(saved).toBe(true);
});
it("rejects a failed durable write, retains the previous asset, and leaves the pending value retryable", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-fail:"); activate(storage);
  const previousAsset = await importWritingNoteAsset("manuscript-a", imageFile());
  const failedId = "11111111-1111-4111-8111-111111111111";
  vi.spyOn(crypto, "randomUUID").mockReturnValue(failedId);
  database.failNext(new DOMException("full", "QuotaExceededError"));
  await expect(importWritingNoteAsset("manuscript-a", imageFile())).rejects.toThrow("QuotaExceededError");
  expect(storagePersistence(storage)?.pending).toBe(true);
  activate(await createIndexedPreviewStorage("writing-assets-fail:"));
  expect(await readWritingNoteAsset("manuscript-a", previousAsset.assetId)).toEqual(bytes);
  await expect(readWritingNoteAsset("manuscript-a", failedId)).rejects.toThrow("附件不存在");
  await storagePersistence(storage)!.retry();
  activate(await createIndexedPreviewStorage("writing-assets-fail:"));
  expect(await readWritingNoteAsset("manuscript-a", failedId)).toEqual(bytes);
});
it("does not transfer an import into a different runtime while reading the clipboard file", async () => {
  const first = await createIndexedPreviewStorage("writing-assets-source:"), second = await createIndexedPreviewStorage("writing-assets-target:"); activate(first);
  let release!: (value: ArrayBuffer) => void;
  const file = imageFile(); Object.defineProperty(file, "arrayBuffer", {value: () => new Promise<ArrayBuffer>(done => {release = done;}), configurable: true});
  const importing = importWritingNoteAsset("manuscript-a", file);
  activate(second); release(bytes.slice().buffer);
  await expect(importing).rejects.toThrow("writing_note_asset_owner_changed");
  expect(first.length).toBe(0); expect(second.length).toBe(0);
});
it("retains corrupt bytes and reports an invalid persisted record instead of coercing it", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-corrupt:"); activate(storage);
  const asset = await importWritingNoteAsset("manuscript-a", imageFile());
  const key = storage.key(0)!, record = JSON.parse(storage.getItem(key)!);
  const corrupt = JSON.stringify({...record, bytes: [0, 256]}); storage.setItem(key, corrupt);
  await expect(readWritingNoteAsset("manuscript-a", asset.assetId)).rejects.toThrow("writing_note_asset_corrupt");
  expect(storage.getItem(key)).toBe(corrupt);
});
it("rejects actual bytes above the asset limit even if the clipboard reports a smaller file", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-large:"); activate(storage);
  const file = imageFile(); Object.defineProperty(file, "arrayBuffer", {value: async () => new ArrayBuffer(MAX_WRITING_NOTE_ASSET_BYTES + 1), configurable: true});
  await expect(importWritingNoteAsset("manuscript-a", file)).rejects.toThrow("16 MiB");
  expect(storage.length).toBe(0);
});
it("keeps desktop asset business payloads on the selected typed port", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-native:"); selectAppRuntime({mode: "desktop", storage, gateways: {}, dispose() {}});
  const asset = {assetId: "22222222-2222-4222-8222-222222222222", displayName: "22222222-2222-4222-8222-222222222222.png", mimeType: "image/png"};
  native.assets.importAsset.mockResolvedValueOnce(asset);
  native.assets.readAsset.mockResolvedValueOnce([...bytes]);
  expect(await importWritingNoteAsset("manuscript-a", imageFile())).toEqual(asset);
  expect(native.assets.importAsset).toHaveBeenCalledExactlyOnceWith({manuscriptId: "manuscript-a", displayName: "image", mimeType: "image/png", bytes: [...bytes]});
  expect(await readWritingNoteAsset("manuscript-a", asset.assetId)).toEqual(bytes);
  expect(native.assets.readAsset).toHaveBeenCalledExactlyOnceWith("manuscript-a", asset.assetId);
  expect(native.invoke).not.toHaveBeenCalled();
  expect(storage.length).toBe(0);
});

it("keeps native Agent preview assets on the existing browser storage path", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-native-agent:");
  const {runtime} = activate(storage);
  Object.assign(runtime, {nativeAgentPreview: {}});
  const asset = await importWritingNoteAsset("manuscript-a", imageFile());
  await expect(readWritingNoteAsset("manuscript-a", asset.assetId)).resolves.toEqual(bytes);
  expect(native.getAssets).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
});

it("retains a non-image attachment's original filename", async () => {
  const storage = await createIndexedPreviewStorage("writing-assets-attachment:"); activate(storage);
  const file = new File([bytes.buffer], "实验说明.txt", {type: "text/plain"});
  Object.defineProperty(file, "arrayBuffer", {value: async () => bytes.slice().buffer});
  expect(await importWritingNoteAsset("manuscript-a", file)).toMatchObject({displayName: "实验说明.txt", mimeType: "text/plain"});
  expect(storage.getItem(storage.key(0)!)).toContain("实验说明.txt");
});

it("rejects an owner switch while checking the manuscript without writing either storage", async () => {
  const first = await createIndexedPreviewStorage("writing-assets-list-source:");
  const second = await createIndexedPreviewStorage("writing-assets-list-target:");
  let finish!: () => void;
  const list = vi.fn(() => new Promise<never[]>(resolve => {finish = () => resolve([]);}));
  activate(first, list);
  const importing = importWritingNoteAsset("manuscript-a", imageFile());
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  activate(second); finish();
  await expect(importing).rejects.toThrow("writing_note_asset_owner_changed");
  expect(first.length).toBe(0);
  expect(second.length).toBe(0);
});

it("flushes the captured owner before rejecting a switch during its durable receipt", async () => {
  const first = await createIndexedPreviewStorage("writing-assets-flush-source:");
  const second = await createIndexedPreviewStorage("writing-assets-flush-target:");
  activate(first);
  let finish!: () => void;
  database.holdUntil(new Promise<void>(resolve => {finish = resolve;}));
  const importing = importWritingNoteAsset("manuscript-a", imageFile());
  await vi.waitFor(() => expect(storagePersistence(first)?.pending).toBe(true));
  const key = first.key(0)!;
  const original = first.getItem(key);
  activate(second); finish();
  await expect(importing).rejects.toThrow("writing_note_asset_owner_changed");
  expect(storagePersistence(first)?.pending).toBe(false);
  expect(second.length).toBe(0);
  const reopened = await createIndexedPreviewStorage("writing-assets-flush-source:");
  expect(reopened.getItem(key)).toBe(original);
});
