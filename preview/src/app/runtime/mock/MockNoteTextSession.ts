import type { NoteDocumentSnapshot, NotesGateway } from "@research-assistant/data/notes";
import type { NoteDocumentV1, NotePageId } from "@research-assistant/core/notes";
import type { NoteTextSessionGateway, NoteTextSessionOptions } from "@research-assistant/workbench-preview/note-text-editor-session";
import { checkTextSnapshotReady, flushNoteReview, holdTextEditor, textInstallPort } from "@research-assistant/workbench-preview/note-text-editor-ports";
import type { AppliedNotePage } from "@research-assistant/workbench-preview/note-text-editor-ports";
import { noteReviewRecovery } from "@research-assistant/workbench-preview/note-text-editor-ports";
import { saveNoteRecoveryDraft } from "@research-assistant/workbench-preview/note-recovery";
import {sameNoteProjection} from "@research-assistant/workbench-preview/note-review-projection";

/** Replaces native flush/commit IPC only. The production save coordinator,
 * external lease and editor installation still own the live note session. */
export class MockNoteTextSession implements NoteTextSessionGateway {
  private session: NoteTextSessionOptions | undefined;
  constructor(private readonly notes: NotesGateway, private readonly pageId: string,
    private readonly beforeSave?: () => Promise<void>,
    private readonly saveExternal?: (document: NoteDocumentV1, expectedRevision: number, review?: AppliedNotePage["review"]) => Promise<NoteDocumentSnapshot>) {}
  register = (session: NoteTextSessionOptions): (() => void) => {
    if (session.getSnapshot()?.page.id !== this.pageId) return () => {};
    if (this.session) throw new Error("模拟笔记已有编辑会话");
    this.session = session;
    return () => { if (this.session === session) this.session = undefined; };
  };
  readSaved = () => this.notes.loadDocument(this.pageId as NotePageId);
  flush = async (): Promise<void> => {
    const session = this.session;
    if (!session) throw new Error("请先打开研究笔记，再模拟修改。");
    await flushNoteReview(this.pageId);
    await session.controller.flush();
    if (session !== this.session || session.controller.hasUnsavedChanges()) throw new Error("笔记尚未保存，请先解决保存问题。");
    checkTextSnapshotReady(this.pageId);
  };
  /** Scenario data enters the same mounted editor and CAS queue as real input.
   * The competing write deliberately bypasses this window, like another host. */
  conflict = async (branches: (document: NoteDocumentV1) => { current: NoteDocumentV1; saved: NoteDocumentV1 }): Promise<NoteDocumentSnapshot> => {
    await this.flush();
    const session = this.session;
    const before = session?.getSnapshot();
    if (!session || !before) throw new Error("请先打开测试笔记。");
    const installer = textInstallPort(this.pageId), actual = installer.read();
    const next = branches(actual);
    try { installer.prepare(actual, next.current)(); }
    catch (reason) { session.controller.restore(installer.read(), "conflict"); throw reason; }
    session.controller.enqueue(next.current);
    const saved = await this.notes.saveDocument({ document: next.saved, expectedRevision: before.page.revision, saveReason: "manual" });
    await session.controller.flush();
    session.onChanged(saved.page.revision);
    return saved;
  };
  preserveForReopen = (): void => {
    const before = this.session?.getSnapshot();
    if (!before) throw new Error("请先打开测试笔记。");
    saveNoteRecoveryDraft(before.page.id, before.page.revision, textInstallPort(this.pageId).read(), noteReviewRecovery(this.pageId));
  };
  apply = async (document: NoteDocumentV1, expectedRevision: number, review?: AppliedNotePage["review"]): Promise<NoteDocumentSnapshot> => {
    // Fence input before simulated command latency. Lease admission follows
    // preflight so an injected failure leaves no dispatched lease.
    const requestId = crypto.randomUUID();
    const installsDocument = review?.origin !== "manual";
    if (installsDocument) holdTextEditor(this.pageId, requestId, true);
    try {
      await this.beforeSave?.();
      const session = this.session, baseline = session?.getSnapshot();
      if (!session && this.saveExternal && review) {
        const current = await this.readSaved();
        if (current.page.revision !== expectedRevision || !sameNoteProjection(current.document, document))
          throw {status: "failed", message: "正文或版本已变化，请先打开笔记核对修改"};
        // Native decisions need no installation lease when no editor exists.
        // Only the unchanged formal body may take this path; B still commits
        // through the shared authority's actual transaction and CAS.
        return this.saveExternal(document, expectedRevision, review);
      }
      if (!session || !baseline || baseline.page.revision !== expectedRevision) throw { status: "failed", message: "笔记版本已变化" };
      // Formal S supplies the saved revision; the fenced editor may be showing
      // candidate D. Capture that admission now, before any asynchronous save.
      const installer = textInstallPort(this.pageId);
      const admittedDocument = installer.read();
      const install = session.controller.synchronizeExternal || !installsDocument ? () => undefined : installer.prepareStructure(admittedDocument, document, review ? {
        baseline: review.baseline, origin: review.origin, addToHistory: review.addToHistory,
        ...(review.requestId ? { requestId: review.requestId } : {}),
      } : undefined);
      const lease = session.controller.beginExternalChange(expectedRevision, baseline.document);
      if (!lease) throw { status: "failed", message: "笔记编辑会话正忙" };
      let dispatched = false;
      try {
        if (!lease.markDispatched()) throw new Error("编辑器版本已变化");
        dispatched = true;
        const result = this.saveExternal ? await this.saveExternal(document, expectedRevision, review)
          : await this.notes.saveDocument({ document, expectedRevision, saveReason: "structure" });
        await session.controller.synchronizeExternal?.(result, review?.baseline);
        if (this.session !== session || !lease.commitGroup(result, result.page.revision, install)) throw new Error("模拟修改已保存，编辑器安装需恢复");
        session.onChanged(result.page.revision);
        return result;
      } catch (reason) {
        if (dispatched) lease.requireRecovery(); else lease.cancelBeforeDispatch();
        throw reason;
      }
    } finally { if (installsDocument) holdTextEditor(this.pageId, requestId, false); }
  };
}
