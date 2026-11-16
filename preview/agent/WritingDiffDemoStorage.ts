import { isWritingSourcePath, parseManuscriptPath, type WritingCheckpointRecord } from "@research-assistant/writing";
import type { WritingGateway } from "@research-assistant/data/writing";
import { createMemoryWritingCheckpointGateway, type WritingCheckpointGateway } from "../../src/features/writing/gateway/writingCheckpointGateway";
import type { DemoChange } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import { sameWritingDiffDemoBytes, writingDiffDemoBytes, writingDiffDemoText } from "./WritingDiffDemoBytes";

export type WritingDiffDemoFault = "none" | "tool" | "toolRetry" | "file" | "checkpoint" | "both" | "fileReceipt" | "checkpointReceipt" | "delayed" | "dispatch" | "editorConfirm" | "diskConfirm";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
export {writingDiffDemoHash};

/** Mock I/O only. Exact disk bytes and checkpoints outlive disposable editors. */
export class WritingDiffDemoStorage {
  readonly initialOpenPaths: readonly string[];
  private readonly disk: Map<string, Uint8Array>;
  private readonly preserved = new Map<string, Uint8Array>();
  private readonly changes = new Map<string, { before: Uint8Array | null; after: Uint8Array | null; restored: boolean }>();
  private readonly records = new Map<string, WritingCheckpointRecord>();
  private readonly memory = createMemoryWritingCheckpointGateway(this.records);
  private faultValue: WritingDiffDemoFault = "none";
  private readonly lastChangePath: string | undefined;
  private receiptLost = false;
  ioDelayMs = 500;
  get fault(): WritingDiffDemoFault { return this.faultValue; }
  set fault(value: WritingDiffDemoFault) {
    if (value !== this.faultValue) this.receiptLost = false;
    this.faultValue = value;
  }
  constructor(private readonly manuscriptId: string, changes: readonly DemoChange[]) {
    this.lastChangePath = changes.at(-1)?.path;
    this.disk = new Map(changes.filter(change => change.kind !== "added").map((change) => [change.path, writingDiffDemoBytes(change, "before")]));
    this.initialOpenPaths = changes.filter(change => change.kind === "modified" && isWritingSourcePath(change.path)
      && writingDiffDemoText(writingDiffDemoBytes(change, "before")) !== null).map(change => change.path);
  }
  private checkIdentity(manuscriptId: string): void {
    if (manuscriptId !== this.manuscriptId) throw new Error("演示稿件身份不匹配");
  }
  private restorationProof(manuscriptId: string, path: string, before: Uint8Array | null, after: Uint8Array | null, operationId: string) {
    this.checkIdentity(manuscriptId);
    const relativePath = parseManuscriptPath(path), key = JSON.stringify([operationId, relativePath]);
    const change = this.changes.get(key);
    if (!change || !sameWritingDiffDemoBytes(change.before, before) || !sameWritingDiffDemoBytes(change.after, after)) throw new Error("模拟回滚缺少原操作证明");
    if (!sameWritingDiffDemoBytes(this.disk.get(relativePath) ?? null, change.restored ? before : after)
      || (before !== null && !sameWritingDiffDemoBytes(this.preserved.get(key) ?? null, before))) throw new Error("模拟回滚文件或备份冲突");
    return { relativePath, change };
  }
  readonly files: Pick<WritingGateway, "readFile" | "saveFile" | "createFile" | "listFiles" | "clearRecoveryDraft"> & {
    readBytes(manuscriptId: string, path: string): Promise<Uint8Array>;
    applyChange(manuscriptId: string, path: string, before: string | Uint8Array | null, after: string | Uint8Array | null, operationId: string): Promise<void>;
    readPreserved(manuscriptId: string, path: string, operationId: string): Promise<Uint8Array | null>;
    checkRestoration(manuscriptId: string, path: string, before: Uint8Array | null, after: Uint8Array | null, operationId: string): Promise<void>;
    restoreChange(manuscriptId: string, path: string, before: Uint8Array | null, after: Uint8Array | null, operationId: string): Promise<void>;
  } = {
    readBytes: async (manuscriptId, path) => {
      this.checkIdentity(manuscriptId);
      const bytes = this.disk.get(parseManuscriptPath(path));
      if (!bytes) throw new Error("演示文件不存在");
      return Uint8Array.from(bytes);
    },
    readPreserved: async (manuscriptId, path, operationId) => {
      this.checkIdentity(manuscriptId);
      const bytes = this.preserved.get(JSON.stringify([operationId, parseManuscriptPath(path)]));
      return bytes ? Uint8Array.from(bytes) : null;
    },
    applyChange: async (manuscriptId, path, before, after, operationId) => {
      this.checkIdentity(manuscriptId);
      const relativePath = parseManuscriptPath(path);
      const source = typeof before === "string" ? new TextEncoder().encode(before) : before;
      const destination = typeof after === "string" ? new TextEncoder().encode(after) : after;
      if (this.fault === "file" || this.fault === "both") throw new Error("模拟正式文件保存失败");
      if (!sameWritingDiffDemoBytes(this.disk.get(relativePath) ?? null, source)) throw Object.assign(new Error("演示文件已被外部修改"), { code: "file_conflict" });
      const changeKey = JSON.stringify([operationId, relativePath]);
      if (this.changes.has(changeKey)) throw new Error("模拟文件操作不能重复派发");
      // Native replacement/removal preserves its source before mutating the
      // destination. Recovery requires this operation's backup, not just after bytes.
      if (source !== null) {
        const key = JSON.stringify([operationId, relativePath]), existing = this.preserved.get(key);
        if (existing !== undefined && !sameWritingDiffDemoBytes(existing, source)) throw new Error("模拟原始文件备份冲突");
        this.preserved.set(key, Uint8Array.from(source));
      }
      if (destination === null) this.disk.delete(relativePath);
      else this.disk.set(relativePath, Uint8Array.from(destination));
      this.changes.set(changeKey, { before: source === null ? null : Uint8Array.from(source),
        after: destination === null ? null : Uint8Array.from(destination), restored: false });
      await this.reply("fileReceipt");
    },
    checkRestoration: async (manuscriptId, path, before, after, operationId) => {
      this.restorationProof(manuscriptId, path, before, after, operationId);
    },
    restoreChange: async (manuscriptId, path, before, after, operationId) => {
      // No await between validating current bytes and the physical mutation.
      const { relativePath, change } = this.restorationProof(manuscriptId, path, before, after, operationId);
      if (change.restored) return;
      if (this.fault === "file" || this.fault === "both") throw new Error("模拟正式文件恢复失败");
      if (before === null) this.disk.delete(relativePath);
      else this.disk.set(relativePath, Uint8Array.from(before));
      change.restored = true;
      await this.reply("fileReceipt");
    },
    listFiles: async (manuscriptId) => {
      this.checkIdentity(manuscriptId);
      return Promise.all([...this.disk].map(async ([path, content]) => ({ manuscriptId,
        relativePath: parseManuscriptPath(path), kind: path.endsWith(".tex") ? "tex" as const : "other" as const,
        sizeBytes: content.byteLength, sha256: await writingDiffDemoHash(content), modifiedAt: "2026-10-07T00:00:00Z" })));
    },
    createFile: async (manuscriptId, path, content = "") => {
      this.checkIdentity(manuscriptId);
      const relativePath = parseManuscriptPath(path);
      if (this.fault === "file" || this.fault === "both") throw new Error("模拟正式文件保存失败");
      const sha256 = await writingDiffDemoHash(content);
      if (this.disk.has(relativePath)) throw new Error("演示文件已存在");
      this.disk.set(relativePath, new TextEncoder().encode(content));
      return { relativePath, content, sha256 };
    },
    // Legacy body-only drafts are not part of this mock adapter. Complete
    // checkpoint records are intentionally preserved by this cleanup command.
    clearRecoveryDraft: async (manuscriptId) => { this.checkIdentity(manuscriptId); },
    readFile: async (manuscriptId, path) => {
      this.checkIdentity(manuscriptId);
      const bytes = await this.files.readBytes(manuscriptId, path);
      if (bytes.includes(0)) throw new Error("二进制文件不能作为文本读取");
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { relativePath: parseManuscriptPath(path), content, sha256: await writingDiffDemoHash(bytes) };
    },
    saveFile: async (request) => {
      this.checkIdentity(request.manuscriptId);
      if (this.fault === "file" || this.fault === "both") throw new Error("模拟正式文件保存失败");
      const current = this.disk.get(request.relativePath);
      const expected = current === undefined ? undefined : await writingDiffDemoHash(current);
      if (request.expectedSha256 !== expected) throw Object.assign(new Error("演示文件已被外部修改"), { code: "file_conflict" });
      const sha256 = await writingDiffDemoHash(request.content);
      // Recheck after async hashing just as native atomic replacement guards its source.
      if (this.disk.get(request.relativePath) !== current) throw Object.assign(new Error("演示文件已被外部修改"), { code: "file_conflict" });
      this.disk.set(request.relativePath, new TextEncoder().encode(request.content));
      if (this.fault === "diskConfirm" && request.relativePath === this.lastChangePath) {
        throw new Error("模拟最后文件已写入，但磁盘签收日志尚未记录");
      }
      await this.reply("fileReceipt");
      return { relativePath: request.relativePath, content: request.content, sha256 };
    },
  };
  readonly checkpoints: WritingCheckpointGateway = {
    list: async (manuscriptId) => { this.checkIdentity(manuscriptId); return this.memory.list(manuscriptId); },
    save: async (write) => {
      this.checkIdentity(write.checkpoint.manuscriptId);
      if (this.fault === "checkpoint" || this.fault === "both") throw new Error("模拟恢复检查点保存失败");
      const record = await this.memory.save(write);
      await this.reply("checkpointReceipt");
      return record;
    },
  };
  /** Commit precedes the injected reply fault: retries must reconcile durable
   * state through production controllers, not repeat the editor operation. */
  private async reply(kind: "fileReceipt" | "checkpointReceipt"): Promise<void> {
    if (this.fault === kind && !this.receiptLost) {
      this.receiptLost = true;
      throw new Error(kind === "fileReceipt" ? "模拟正式文件已写入但回执丢失" : "模拟检查点已写入但回执丢失");
    }
    if (this.fault === "delayed") await new Promise<void>(resolve => setTimeout(resolve, this.ioDelayMs));
  }
  /** A separate actor changes formal text without touching the editor or recovery records. */
  async externalEdit(path: string, content: string): Promise<void> {
    parseManuscriptPath(path);
    if (!this.disk.has(path)) throw new Error("演示文件不存在");
    this.disk.set(path, new TextEncoder().encode(content));
  }
}
