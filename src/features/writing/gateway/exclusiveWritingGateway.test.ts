import { expect, it, vi } from "vitest";
import type { WritingGateway } from "./writingGateway";
import { createExclusiveWritingGateway } from "./exclusiveWritingGateway";

it("drains started work and rejects new source work until idempotent release", async () => {
  let finish!: () => void;
  const renameDirectory = vi.fn(() => new Promise<void>(resolve => {finish = resolve;}));
  const saveFile = vi.fn().mockResolvedValue({});
  const listFiles = vi.fn().mockResolvedValue([]);
  const saveRecoveryDraft = vi.fn().mockResolvedValue({});
  const access = createExclusiveWritingGateway({renameDirectory, saveFile, listFiles, saveRecoveryDraft} as unknown as WritingGateway);
  const started = access.gateway.renameDirectory("m", "old", "new");
  let acquired = false;
  const lease = access.acquire().then(release => {acquired = true; return release;});
  await Promise.resolve();
  expect(acquired).toBe(false);
  await expect(access.gateway.saveFile({} as never)).rejects.toThrow("正在核对或应用提案");
  expect(saveFile).not.toHaveBeenCalled();
  await expect(access.gateway.listFiles("m")).resolves.toEqual([]);
  await access.gateway.saveRecoveryDraft({} as never);
  expect(saveRecoveryDraft).toHaveBeenCalledTimes(1);
  await expect(access.acquire()).rejects.toThrow("另一项提案");
  finish(); await started;
  const release = await lease;
  expect(access.isExclusive()).toBe(true);
  release(); release();
  await access.gateway.saveFile({} as never);
  expect(saveFile).toHaveBeenCalledTimes(1);
});

it("waits for a failing adapter without treating its failure as successful source work", async () => {
  let reject!: (reason: Error) => void;
  const source = {syncBibliography: vi.fn(() => new Promise((_resolve, fail) => {reject = fail;}))} as unknown as WritingGateway;
  const access = createExclusiveWritingGateway(source);
  const work = access.gateway.syncBibliography("m", []);
  const failure = expect(work).rejects.toThrow("native failure");
  const lease = access.acquire();
  await Promise.resolve();
  reject(new Error("native failure"));
  await failure;
  const release = await lease;
  expect(access.isExclusive()).toBe(true);
  release();
  expect(access.isExclusive()).toBe(false);
});

it("protects independent directory, bibliography and source snapshot entry points", async () => {
  const keys = ["createDirectory", "deleteDirectory", "renameDirectory", "bindCitation", "syncBibliography", "removeUnusedImportedBibliographyEntries",
    "regenerateBibliography", "preserveBibliographyEdits", "startCompile", "exportSource", "readFile",
    "importResources", "importProject", "duplicateManuscript", "deleteManuscript", "isCompileCurrent"] as const;
  const methods = Object.fromEntries(keys.map(key => [key, vi.fn().mockResolvedValue(undefined)]));
  const access = createExclusiveWritingGateway(methods as unknown as WritingGateway);
  const release = await access.acquire();
  for (const key of keys) {
    const method=access.gateway[key];
    if(!method)throw new Error(`Missing protected method: ${key}`);
    await expect(Reflect.apply(method, access.gateway, [])).rejects.toThrow("正在核对或应用提案");
    expect(methods[key]).not.toHaveBeenCalled();
  }
  release();
});
