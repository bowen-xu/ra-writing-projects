import {noteBlockId, notePageId, type NoteDocumentV1} from "@research-assistant/core/notes";
import type {NotesGateway} from "@research-assistant/data/notes";
import {AppNoteHbsSession} from "@research-assistant/workbench-preview/app-note-hbs-session";
import type {createBrowserNoteHbsAuthority} from "@research-assistant/workbench-preview/browser-note-hbs-authority";
import {getHbsDocumentGateway} from "@research-assistant/workbench-preview/hbs-document-gateway";
import {flushStorage} from "@research-assistant/workbench-preview/storage-persistence";
import {noteRecoveryCases, type NoteRecoveryPreview, type NoteRecoveryScenario} from "@research-assistant/workbench-preview/note-recovery-preview";

const key = "note-recovery-fixture.v1";
type Authority = ReturnType<typeof createBrowserNoteHbsAuthority>;
interface Fixture {readonly pageId: string; readonly prepared: boolean; readonly released?: boolean; readonly spent?: boolean}

/** Only transport/storage responses are faulty. State, conflict detection,
 * checkpoint decoding, outbox replay and editing remain production-owned. */
export function createMockNoteRecovery(storage: Storage, scenario: NoteRecoveryScenario, notes: NotesGateway, authority: Authority) {
  let fixture = JSON.parse(storage.getItem(key) ?? "null") as Fixture | null;
  let armed = !!fixture?.prepared;
  const save = async (change: Partial<Fixture>) => {
    fixture = {...fixture!, ...change}; storage.setItem(key, JSON.stringify(fixture)); await flushStorage(storage);
  };
  const active = () => armed && !fixture?.released;
  const failure = (phase: string): never => {throw Object.assign(new Error(`MOCK_NOTE_${phase}：故障预览注入的存储／传输失败。`), {code: `MOCK_NOTE_${phase}`});};
  function edit(document: NoteDocumentV1, value: string): NoteDocumentV1 {
    return {...document, blocks: document.blocks.map(block => block.id === "recovery-argument"
      ? {...block, content: {kind: "inline", items: [{type: "text", text: value, styles: []}]}} : block)};
  }
  const preview: NoteRecoveryPreview = {scenario, get pageId() {return fixture?.pageId ?? "";},
    releaseFault: async () => {await save({released: true});},
  };
  async function invoke(command: string, id: string, apply: () => Promise<unknown>): Promise<unknown> {
    if (!active() || id !== fixture?.pageId) return apply();
    if (command === "hbs_read_preservation") {
      if (scenario === "checkpoint-read") failure("CHECKPOINT_READ");
      if (scenario === "checkpoint-invalid") return {format: 1, kind: "note", content: "broken mock checkpoint"};
    }
    if (command === "hbs_save_preservation" && scenario === "checkpoint-write") failure("CHECKPOINT_WRITE");
    if (command !== "hbs_commit_document") return apply();
    if (scenario === "save-failure") failure("COMMIT_BEFORE_WRITE");
    if (scenario === "resolution-failure") failure("RESOLUTION_BEFORE_WRITE");
    if (scenario === "stale-resolution") {
      const current = await authority.read(fixture.pageId);
      await authority.saveExternal({document: edit(current.saved, `另一写入者又更新了正文 v${current.version + 1}。`), expectedRevision: current.version, saveReason: "manual"}, current.baseline);
    }
    const result = await apply();
    if (scenario === "resolution-unknown") failure("RESOLUTION_RECEIPT_LOST");
    if (scenario === "stuck-request") failure("RECEIPT_LOST");
    if (scenario === "lost-receipt" && !fixture.spent) {await save({spent: true}); failure("RECEIPT_LOST");}
    return result;
  }
  async function prepare(): Promise<void> {
    if (fixture?.prepared) return;
    armed = false;
    const label = noteRecoveryCases.find(item => item[0] === scenario)![1];
    if (!fixture) {const created = await notes.createPage({title: `故障预览 · ${label}`}); await save({pageId: created.page.id, prepared: false});}
    const pageId = notePageId(fixture!.pageId), loaded = await notes.loadDocument(pageId);
    const asset = await notes.importNoteAsset({displayName: "fixture.svg", mimeType: "image/svg+xml", bytes: [...new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180"><rect width="600" height="180" fill="#e2ebe4"/><text x="30" y="75" font-size="26" fill="#314a39">Synthetic recovery image</text><text x="30" y="120" font-size="20" fill="#314a39">Mock data / production editor</text></svg>')]});
    const base: NoteDocumentV1 = {schemaVersion: 1, pageId, title: loaded.page.title, blocks: [
      {id: noteBlockId("recovery-argument"), type: "paragraph", props: {}, content: {kind: "inline", items: [{type: "text", text: "基线：模型准确率为 80%。", styles: []}]}, children: []},
      {id: noteBlockId("recovery-image"), type: "image", props: {previewScale: 100}, content: {kind: "asset", assetId: asset.id, displayName: asset.displayName, mimeType: asset.mimeType, caption: "故障预览合成图片"}, children: []},
      {id: noteBlockId("recovery-next"), type: "paragraph", props: {}, content: {kind: "inline", items: [{type: "text", text: "独立的普通段落，用于验证恢复后继续编辑。", styles: []}]}, children: []},
    ]};
    await authority.saveExternal({document: base, expectedRevision: loaded.page.revision, saveReason: "manual"}, base);
    const conflicted = ["conflict", "resolution-failure", "resolution-unknown", "stale-resolution"].includes(scenario);
    if (conflicted) {
      const current = await authority.read(pageId);
      await authority.saveExternal({document: edit(base, "AI 候选：模型准确率为 85%。"), expectedRevision: current.version, saveReason: "manual"}, base);
    }
    const controller = await AppNoteHbsSession.open({loaded: await notes.loadDocument(pageId), gateway: getHbsDocumentGateway(),
      onSnapshot: () => {}, onStatus: () => {}, onDurable: () => {}});
    controller.start();
    try {
      controller.enqueue(edit(base, conflicted ? "当前编辑：模型准确率为 185%。" : "当前编辑：模型准确率为 81%。"));
      await controller.ensurePreserved();
      if (conflicted) {
        await controller.flush();
        const current = await authority.read(pageId);
        await authority.saveExternal({document: edit(base, "另一写入者：模型准确率为 90%。"), expectedRevision: current.version, saveReason: "manual"}, base);
      } else if (["save-failure", "lost-receipt", "stuck-request"].includes(scenario)) {armed = true; await controller.flush();}
    } finally {controller.dispose();}
    await save({prepared: true}); armed = true;
  }
  return {preview, invoke, prepare};
}
