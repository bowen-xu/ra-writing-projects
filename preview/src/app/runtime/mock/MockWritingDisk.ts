import { parseManuscriptPath } from "@research-assistant/writing";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";
import type { WritingDiffDemoStorage } from "../../../../agent/WritingDiffDemoStorage";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
import { sameWritingDiffDemoBytes } from "../../../../agent/WritingDiffDemoBytes";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";

/** The Agent and normal save controls address the very same simulated disk. */
export class MockWritingDisk {
  private readonly operations: Map<string, { manuscriptId: string; path: string; before: Uint8Array | null; after: Uint8Array | null; restored: boolean }>;
  constructor(private readonly gateway: WritingGateway, private readonly storage: Storage) {
    this.operations = decodeMockState(storage.getItem("writing-disk-operations") ?? encodeMockState(new Map()));
  }
  private persist(): void { this.storage.setItem("writing-disk-operations", encodeMockState(this.operations)); }
  private async read(manuscriptId: string, path: string): Promise<Uint8Array | null> {
    if (!(await this.gateway.listFiles(manuscriptId)).some(file => file.relativePath === path)) return null;
    return new TextEncoder().encode((await this.gateway.readFile(manuscriptId, path)).content);
  }
  private async replace(manuscriptId: string, path: string, before: Uint8Array | null, after: Uint8Array | null): Promise<void> {
    if (!sameWritingDiffDemoBytes(await this.read(manuscriptId, path), before)) throw Object.assign(new Error("模拟文件版本冲突"), { code: "file_conflict" });
    if (after === null) await this.gateway.deleteFile(manuscriptId, path);
    else if (before === null) await this.gateway.createFile(manuscriptId, path, new TextDecoder().decode(after));
    else await this.gateway.saveFile({ manuscriptId, relativePath: parseManuscriptPath(path), content: new TextDecoder().decode(after), expectedSha256: await writingDiffDemoHash(before) });
  }
  readonly files: WritingDiffDemoStorage["files"] = {
    readFile: (...args) => this.gateway.readFile(...args), saveFile: request => this.gateway.saveFile(request),
    createFile: (...args) => this.gateway.createFile(...args), listFiles: id => this.gateway.listFiles(id),
    clearRecoveryDraft: (...args) => this.gateway.clearRecoveryDraft(...args),
    readBytes: async (id, path) => { const bytes = await this.read(id, path); if (!bytes) throw new Error("模拟文件不存在"); return bytes; },
    applyChange: async (manuscriptId, path, source, destination, operationId) => {
      const before = typeof source === "string" ? new TextEncoder().encode(source) : source;
      const after = typeof destination === "string" ? new TextEncoder().encode(destination) : destination;
      const key = JSON.stringify([operationId, path]);
      if (this.operations.has(key)) throw new Error("文件操作不能重复派发");
      this.operations.set(key, { manuscriptId, path, before, after, restored: false }); this.persist();
      await this.replace(manuscriptId, path, before, after);
    },
    readPreserved: async (_id, path, operationId) => this.operations.get(JSON.stringify([operationId, path]))?.before ?? null,
    checkRestoration: async (id, path, before, after, operationId) => {
      const operation = this.operations.get(JSON.stringify([operationId, path]));
      if (!operation || operation.manuscriptId !== id || !sameWritingDiffDemoBytes(operation.before, before)
        || !sameWritingDiffDemoBytes(operation.after, after) || !sameWritingDiffDemoBytes(await this.read(id, path), operation.restored ? before : after)) throw new Error("文件恢复证明不匹配");
    },
    restoreChange: async (id, path, before, after, operationId) => {
      await this.files.checkRestoration(id, path, before, after, operationId);
      const operation = this.operations.get(JSON.stringify([operationId, path]));
      if (!operation || operation.restored) return;
      await this.replace(id, path, after, before); operation.restored = true; this.persist();
    },
  };
}
