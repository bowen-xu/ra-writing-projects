import { downloadDir, join } from "@research-assistant/workbench-sdk/platform";
import {getRuntimeEnvironment, getRuntimeStorage, isDesktopRuntime, type RuntimeEnvironment} from "@research-assistant/workbench-sdk/environment";
import {getWritingNoteAssetNativeGateway} from "@research-assistant/workbench-sdk/writing-runtime";
import { MAX_WRITING_NOTE_ASSET_BYTES, type WritingNoteAsset } from "@research-assistant/writing";
import { noteImageDisplayName } from "@research-assistant/core/notes";
import { flushStorage } from "@research-assistant/workbench-sdk/storage";
import { getWritingGateway } from "../gateway";

function assetStorageKey(manuscriptId: string, assetId: string): string {
  return "research-assistant.writing-note-asset.v1:" + JSON.stringify([manuscriptId, assetId]);
}

function assertAssetOwner(owner: {mode: RuntimeEnvironment["mode"]; storage: Storage}): void {
  const current = getRuntimeEnvironment();
  if (current.mode !== owner.mode || getRuntimeStorage(current) !== owner.storage) {
    throw new Error("writing_note_asset_owner_changed: 附件所属空间已切换，请在当前空间重新插入");
  }
}

/** The active runtime owns preview bytes and their durable write receipt. */
export async function importWritingNoteAsset(manuscriptId: string, file: File): Promise<WritingNoteAsset> {
  const runtime = getRuntimeEnvironment(), owner = {mode: runtime.mode, storage: getRuntimeStorage(runtime)};
  if (file.size > MAX_WRITING_NOTE_ASSET_BYTES) throw new Error("附件超过 16 MiB 限制");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_WRITING_NOTE_ASSET_BYTES) throw new Error("附件超过 16 MiB 限制");
  assertAssetOwner(owner);
  const mimeType = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(file.type)
    ? file.type : "application/octet-stream";
  if (owner.mode === "desktop") return getWritingNoteAssetNativeGateway().importAsset( { manuscriptId, displayName: mimeType.startsWith("image/") ? "image" : file.name, mimeType, bytes: [...bytes] });
  await getWritingGateway().listFiles(manuscriptId);
  assertAssetOwner(owner);
  const assetId = crypto.randomUUID();
  const displayName = noteImageDisplayName(assetId, mimeType) ?? file.name;
  owner.storage.setItem(assetStorageKey(manuscriptId, assetId), JSON.stringify({
    schemaVersion: 1, manuscriptId, assetId, displayName, mimeType, bytes: [...bytes],
  }));
  // Keep a failed staged value owned by the existing storage retry mechanism.
  await flushStorage(owner.storage);
  assertAssetOwner(owner);
  return { assetId, displayName, mimeType };
}
export async function readWritingNoteAsset(manuscriptId: string, assetId: string): Promise<Uint8Array> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(assetId)) throw new Error("无效的附件标识");
  if (isDesktopRuntime()) return new Uint8Array(await getWritingNoteAssetNativeGateway().readAsset(manuscriptId, assetId));
  const raw = getRuntimeStorage(getRuntimeEnvironment()).getItem(assetStorageKey(manuscriptId, assetId));
  if (raw === null) throw new Error("附件不存在");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("writing_note_asset_corrupt: 附件记录无法解析，原记录已保留"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("writing_note_asset_corrupt: 附件记录格式无效，原记录已保留");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.manuscriptId !== manuscriptId || record.assetId !== assetId
    || typeof record.displayName !== "string" || typeof record.mimeType !== "string"
    || !Array.isArray(record.bytes) || record.bytes.length > MAX_WRITING_NOTE_ASSET_BYTES
    || !record.bytes.every(byte => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("writing_note_asset_corrupt: 附件记录内容无效，原记录已保留");
  }
  return Uint8Array.from(record.bytes as number[]);
}


export async function exportWritingNoteAsset(manuscriptId: string, assetId: string, displayName: string): Promise<string> {
  let name = displayName.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-").replace(/^\.+|[.\s]+$/gu, "") || "attachment";
  if (!name.includes(".")) name += ".bin";
  if (isDesktopRuntime()) {
    const native = getWritingNoteAssetNativeGateway();
    const result = await native.exportAsset({ manuscriptId, assetId, destinationPath: await join(await downloadDir(), name) });
    return result.destinationPath;
  }
  const bytes = await readWritingNoteAsset(manuscriptId, assetId);
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer]));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
