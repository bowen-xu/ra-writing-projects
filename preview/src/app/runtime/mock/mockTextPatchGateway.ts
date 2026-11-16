import { noteBlockId, notePageId, decodeNoteDocument, type NoteBlockV1, type NoteDocumentV1 } from "@research-assistant/core/notes";
import type { TextPatchGateway, TextPatchReview, TextPatchDecision, TextPatchResolution, TextPatchResolutionReceipt } from "@research-assistant/workbench-preview/text-patch-gateway";
import { notifyTextPatchesChanged } from "@research-assistant/workbench-preview/text-patch-gateway";
import type { NoteEditorInstallPort } from "@research-assistant/workbench-preview/note-editor-install-port";
import { sameNoteProjection, synchronizeNoteReviewBaseline } from "@research-assistant/workbench-preview/note-review-projection";
import type { WritingAgentMessage } from "@research-assistant/workbench-preview/writing-agent-message";
import type { NoteDocumentSnapshot } from "@research-assistant/data/notes";
import { PREVIEW_PAPER_ID } from "./mockSeed";
import { mockNoteReviewChunks } from "./mockNoteReviewChunks";
import { renderMockNoteText } from "./mockNoteTextProjection";
import { mockNoteFormatFixture, reviseMockNoteFormats } from "./mockNoteFormatFixture";
import { resolveNoteReviewDocument } from "@research-assistant/workbench-preview/note-review-adapter";
import type { AppliedNotePage } from "@research-assistant/workbench-preview/note-text-editor-ports";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";

interface PreviewNoteHost { readSaved?(): Promise<NoteDocumentSnapshot>; flush(): Promise<void>; apply(document: NoteDocumentV1, expectedRevision: number, review?: AppliedNotePage["review"]): Promise<NoteDocumentSnapshot> }
export const TEXT_PATCH_PREVIEW_CONVERSATION = "00000000-0000-4000-8000-000000000021";
export const TEXT_PATCH_PREVIEW_PAGE = notePageId("00000000-0000-4000-8000-000000000022");
const PATH = `source://notes/${TEXT_PATCH_PREVIEW_PAGE}`;
const ORIGINAL = "逻辑推理模型可以整合局部观察，但目前缺少复杂场景的验证。";
const REVISED = "逻辑推理模型通过累积局部证据更新判断；现有结果支持其可行性，复杂场景中的稳健性仍需验证。";
function block(id: string, type: NoteBlockV1["type"], text: string): NoteBlockV1 {
  return { id: noteBlockId(id), type, props: type === "heading" ? { level: 2 } : {},
    content: { kind: "inline", items: [{ type: "text", text, styles: [] }] }, children: [] };
}
function fixture(): NoteDocumentV1 {
  return { schemaVersion: 1, pageId: TEXT_PATCH_PREVIEW_PAGE, blocks: [
    block("preview-summary", "heading", "研究问题"), block("preview-argument", "paragraph", ORIGINAL),
    block("preview-source-heading", "heading", "资料与链接"),
    { ...block("preview-source", "paragraph", ""), content: { kind: "inline", items: [
      { type: "mention", targetKind: "paper", targetId: PREVIEW_PAPER_ID, labelSnapshot: "逻辑视觉识别研究" },
      { type: "text", text: " · ", styles: [] },
      { type: "link", href: "https://example.org/method", content: [{ type: "text", text: "方法说明", styles: [] }] },
    ] } },
    ...mockNoteFormatFixture(),
  ] };
}
interface Group { readonly original: NoteDocumentV1; readonly baseline: NoteDocumentV1; readonly candidate: NoteDocumentV1; readonly manualEdited?: boolean }
interface StoredReceipt {
  readonly input: string; readonly result: TextPatchResolutionReceipt; readonly before: Group; readonly after: Group;
  readonly formal: { readonly document: NoteDocumentV1; readonly revision: number };
}
export interface TextPatchPreviewSnapshot {
  readonly document: NoteDocumentV1; readonly revision: number; readonly session: number; readonly manualEdit: boolean;
  readonly review: TextPatchReview | null; readonly messages: readonly WritingAgentMessage[];
}
export type MockNoteEdit = "rewrite" | "checklist" | "formats";
type MockNoteEdits = MockNoteEdit | readonly MockNoteEdit[];
export interface MockTextPatchGateway extends TextPatchGateway {
  connectHost(host: PreviewNoteHost): void;
  prepare(): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): TextPatchPreviewSnapshot;
  bindEditor(port: NoteEditorInstallPort | undefined): void;
  /** Formal manual saves invalidate older proposals; candidate typing uses resolve(edit). */
  edit(document: NoteDocumentV1): void;
  /** HBS updates the live S/B projection without rewriting frozen tool history. */
  acknowledgeHbs(document: NoteDocumentV1, baseline: NoteDocumentV1, revision: number): void;
  retire(document: NoteDocumentV1): void;
  /** Synthetic stale cache over an already-confirmed authority, no UI mock. */
  simulateStaleProposal(): void;
  reset(): void;
  read(view: "candidate" | "saved"): string;
  patchText(scenario: MockNoteEdits): string;
  simulate(scenario: MockNoteEdits): Promise<void>;
}
function fail(message = "提案版本已变化"): never { throw { status: "failed", message }; }
function preserveProjection(prior: NoteDocumentV1, editedInput: NoteDocumentV1): NoteDocumentV1 {
  const edited = decodeNoteDocument(editedInput);
  if (edited.pageId !== prior.pageId) return fail("笔记身份已变化");
  const byId = new Map<string, NoteBlockV1>();
  const index = (blocks: readonly NoteBlockV1[]) => blocks.forEach(block => { byId.set(block.id, block); index(block.children); });
  index(prior.blocks);
  const overlay = (blocks: readonly NoteBlockV1[]): NoteBlockV1[] => blocks.map(block => {
    const old = byId.get(block.id);
    if (old && sameNoteProjection({ ...prior, blocks: [old] }, { ...edited, blocks: [block] })) return old;
    const props = { ...old?.props };
    for (const [key, value] of Object.entries(block.props)) {
      if (!(key in props) && ((key === "textAlignment" && value === "left")
        || (["textColor", "backgroundColor"].includes(key) && value === "default"))) continue;
      props[key] = value;
    }
    return { ...block, props, children: overlay(block.children) };
  });
  return { ...edited, blocks: overlay(edited.blocks) };
}

/** Mock execution, review receipts and named tool results. D/B are distinct
 * from formal S. No second patch parser, editor, saver or Markdown import. */
export function createMockTextPatchGateway(enabled = false, storage?: Storage): MockTextPatchGateway {
  let saved = fixture(), group: Group = { original: saved, baseline: saved, candidate: saved };
  let port: NoteEditorInstallPort | undefined, host: PreviewNoteHost | undefined;
  let state: TextPatchPreviewSnapshot = { document: saved, revision: 1, session: 1, manualEdit: false, review: null, messages: [] };
  let serial = 0;
  const listeners = new Set<() => void>(), decisions = new Map<string, { input: string; result: TextPatchDecision }>();
  const receipts = new Map<string, StoredReceipt>();
  const snapshots = new Map<string, Map<number, Group>>(), proposalStates = new Map<string, TextPatchReview>();
  const running = new Map<string, { input: string; promise: Promise<TextPatchResolutionReceipt> }>();
  const runningDecisions = new Map<string, { input: string; promise: Promise<TextPatchDecision> }>();
  const recovery = enabled && storage?.getItem("note-review-preview");
  if (recovery) {
    const restored = decodeMockState<{ saved: NoteDocumentV1; group: Group; state: TextPatchPreviewSnapshot; serial: number;
      receipts: typeof receipts; decisions: typeof decisions; snapshots: typeof snapshots; proposalStates: typeof proposalStates }>(recovery);
    saved = restored.saved; group = restored.group; state = restored.state; serial = restored.serial;
    for (const [key, value] of restored.receipts) receipts.set(key, value);
    for (const [key, value] of restored.decisions) decisions.set(key, value);
    for (const [key, value] of restored.snapshots) snapshots.set(key, value);
    for (const [key, value] of restored.proposalStates) proposalStates.set(key, value);
  }
  const publish = (next: TextPatchPreviewSnapshot) => { state = next; if (state.review) proposalStates.set(state.review.proposalId, state.review);
    if (enabled) storage?.setItem("note-review-preview", encodeMockState({ saved, group, state, serial, receipts, decisions, snapshots, proposalStates }));
    listeners.forEach(listener => listener()); notifyTextPatchesChanged(); };
  const message = (role: WritingAgentMessage["role"], content: string, extra: Partial<WritingAgentMessage> = {}): WritingAgentMessage => ({
    id: `preview-message-${++serial}`, conversationId: TEXT_PATCH_PREVIEW_CONVERSATION, role, content, createdAt: new Date().toISOString(), ...extra,
  });
  const requireFixture = () => { if (!enabled) throw new Error("笔记修改模拟未启用"); };
  const shown = (value: Group, review: TextPatchReview, generation = review.generation, status = review.state, revision = state.revision): TextPatchReview => ({
    ...review, persistenceVersion: 2, generation, operationGeneration: generation, wholeUndoAvailable: !value.manualEdited && ["pending", "accept"].includes(status),
    state: status, pages: [{ pageId: TEXT_PATCH_PREVIEW_PAGE, path: PATH, title: "研究笔记", kind: "update",
      before: renderMockNoteText(value.original), after: renderMockNoteText(value.candidate), expectedRevision: revision,
      beforeDocument: value.original, afterDocument: value.candidate, reviewDocument: value.baseline,
      chunks: mockNoteReviewChunks(value.baseline, value.candidate), metadataPending: false,
      ...(!review.baselineMatches&&status==="pending"?{recovery:{currentRevision:revision,status:"active"}}:{}) }],
  });
  const current = (request: TextPatchDecision | TextPatchResolution) => {
    const review = state.review;
    if (!enabled || request.conversationId !== TEXT_PATCH_PREVIEW_CONVERSATION || request.proposalId !== review?.proposalId) return fail("预览提案不存在");
    if (request.generation !== review.generation) return fail();
    return review;
  };
  const synchronizeSaved = async (allowNewBody = false) => {
    const actual = await host?.readSaved?.();
    if (!actual) return;
    const matches = sameNoteProjection(saved, actual.document);
    if (!matches && (!allowNewBody || state.review?.state === "pending")) return fail("正式笔记版本已变化，请先解决冲突。");
    saved = actual.document;
    if (!matches) group = { original: saved, baseline: saved, candidate: saved };
    state = { ...state, revision: actual.page.revision, ...(!matches ? { document: saved, review: null } : {}) };
  };
  const save = async (next: NoteDocumentV1, review?: AppliedNotePage["review"]): Promise<number> => {
    await synchronizeSaved();
    const bodyChanged = !sameNoteProjection(saved, next);
    const baselineChanged = !!review && !sameNoteProjection(group.baseline, review.baseline);
    if (!bodyChanged && !baselineChanged) return state.revision;
    if (host) {
      // Caller already flushed/owns the candidate queue. Recursive flush here
      // would await this same review transaction indefinitely.
      return (await host.apply(next, state.revision, review)).page.revision;
    }
    // The standalone legacy harness persists B in its own group record. A
    // baseline-only decision advances CAS without reinstalling the same body.
    if (!bodyChanged) return state.revision + 1;
    if (!port) return fail("编辑器尚未就绪");
    if (review?.origin !== "manual") port.prepareStructure(port.read(), next, review ? {
      baseline: review.baseline, origin: review.origin, addToHistory: review.addToHistory,
      ...(review.requestId ? { requestId: review.requestId } : {}),
    } : undefined)();
    return state.revision + 1;
  };
  const plan = (edits: MockNoteEdits) => {
    requireFixture();
    if (state.review?.state === "pending" && !state.review.baselineMatches) return fail("已保存版本变化，请保留输入并撤回旧提案。");
    const old = state.review?.state === "pending" ? group.candidate : saved;
    let blocks = [...old.blocks];
    for (const scenario of typeof edits === "string" ? [edits] : edits) {
      if (scenario === "rewrite") {
        let changed = false;
        blocks = blocks.map(block => {
          if (block.id !== "preview-argument" || block.content.kind !== "inline") return block;
          const items = block.content.items.map(item => {
            if (item.type !== "text" || !item.text.includes(ORIGINAL)) return item;
            changed = true; return { ...item, text: item.text.replace(ORIGINAL, REVISED) };
          });
          return { ...block, content: { kind: "inline", items } };
        });
        if (!changed) throw new Error("示例研究问题已改写或被手动调整；本模拟不会覆盖已有文字，请补充验证清单或重置示例。");
      } else if (scenario === "formats") {
        blocks = reviseMockNoteFormats(blocks);
      } else {
        if (blocks.some(block => block.id === "preview-check-heading")) throw new Error("验证清单已包含在当前版本中，请改写研究问题或重置示例。");
        blocks.push(block("preview-check-heading", "heading", "下一步验证"), block("preview-check-one", "bulletListItem", "在遮挡与噪声条件下评估模型。"),
          block("preview-check-two", "bulletListItem", "比较证据累积与固定阈值基线。"));
      }
    }
    const next = { ...old, blocks }, before = renderMockNoteText(old), after = renderMockNoteText(next);
    const patch = `*** Begin Patch\n*** Update File: ${PATH}\n@@\n${before.trimEnd().split("\n").map(line => `-${line}`).join("\n")}\n${after.trimEnd().split("\n").map(line => `+${line}`).join("\n")}\n*** End Patch`;
    return { old, next, before, patch };
  };
  const resolve = async (request: TextPatchResolution): Promise<TextPatchResolutionReceipt> => {
    const input = JSON.stringify(request), repeated = receipts.get(request.requestId);
    if (repeated) { if (repeated.input !== input) return fail("请求身份冲突"); return repeated.result; }
    if (decisions.has(request.requestId)) return fail("请求身份冲突");
    const inflight = running.get(request.requestId);
    if (inflight) { if (inflight.input !== input) return fail("请求身份冲突"); return inflight.promise; }
    if (running.size || runningDecisions.size) return fail("笔记审阅操作正在处理，请等待原操作结果。");
    const promise = (async () => {
      const review = current(request);
      if(request.action==="retain-current") {
        if(request.pageId!==TEXT_PATCH_PREVIEW_PAGE||request.expectedRevision!==state.revision||!request.document
          ||!sameNoteProjection(request.document,saved)||!sameNoteProjection(group.baseline,saved))return fail("MODEL_NOTE_RECOVERY_SAVE_REQUIRED：请先确认当前正文并核对版本");
        const before=structuredClone(group),next={...group,candidate:saved,baseline:saved,manualEdited:true};
        const result:TextPatchResolutionReceipt={requestId:request.requestId,proposalId:request.proposalId,action:request.action,generation:review.generation,review:null,pages:[]};
        receipts.set(request.requestId,{input,result,before,after:next,formal:{document:saved,revision:state.revision}});
        group=next;publish({...state,review:shown(next,{...review,baselineMatches:true},review.generation,"accept")});return result;
      }
      if ((request.action === "edit") !== !!request.document || (request.action === "restore") !== !!(request.historyRequestId && request.direction)
        || request.chunkId && !["keep", "undo"].includes(request.action)) return fail("审阅参数与操作不匹配");
      if (request.pageId !== TEXT_PATCH_PREVIEW_PAGE || !review.baselineMatches) return fail("已保存笔记版本变化，请保留当前输入。");
      if (request.action !== "restore" && review.state !== "pending" && !(request.action === "edit" && review.state === "accept")) return fail();
      const before = structuredClone(group);
      let next = structuredClone(group);
      if (request.action === "restore") {
        const history = request.historyRequestId ? receipts.get(request.historyRequestId) : undefined;
        if (!history || !request.direction) return fail("审阅历史不可用");
        const expected = request.direction === "undo" ? history.after : history.before;
        if (!sameNoteProjection(group.baseline, expected.baseline) || !sameNoteProjection(group.candidate, expected.candidate)) return fail("审阅历史已变化，请保留输入。");
        next = structuredClone(request.direction === "undo" ? history.before : history.after);
      } else if (request.action === "edit") {
        if (!request.document || request.chunkId) return fail("编辑请求缺少正文");
        const candidate = preserveProjection(group.candidate, request.document);
        next = { ...group, candidate, manualEdited: true, baseline: synchronizeNoteReviewBaseline(group.baseline, group.candidate, candidate) };
      } else if (request.action === "keep" || request.action === "undo") {
        if (request.document) return fail("审阅请求不能改写正文参数");
        const chunk = request.chunkId ? mockNoteReviewChunks(next.baseline, next.candidate).find(chunk => chunk.id === request.chunkId) : undefined;
        if (request.chunkId && !chunk) return fail("变更位置已变化，请读取最新审阅。");
        const result = resolveNoteReviewDocument({ content: next.candidate, reviewBaseline: next.baseline }, request.action, chunk);
        next = { ...next, baseline: result.reviewBaseline, candidate: result.content };
      } else return fail("未知审阅动作");
      renderMockNoteText(next.candidate); renderMockNoteText(next.baseline);
      const complete = !mockNoteReviewChunks(next.baseline, next.candidate).length;
      const unchanged = sameNoteProjection(next.original, next.candidate);
      let revision = state.revision;
      const bodyChanged = !sameNoteProjection(saved, next.candidate);
      const changed = bodyChanged || !sameNoteProjection(group.baseline, next.baseline);
      if (changed) revision = await save(next.candidate, { baseline: next.baseline,
        origin: request.action === "edit" ? "manual" : request.action === "restore" ? "restore" : "review",
        ...(request.action === "keep" || request.action === "undo" ? { requestId: request.requestId } : {}),
        addToHistory: request.action === "keep" || request.action === "undo" });
      const generation = review.generation + 1, status = complete ? unchanged && request.action !== "restore" ? "reject" : "accept" : "pending";
      const nextReview = shown(next, review, generation, status, revision);
      const pages = changed ? [{ pageId: TEXT_PATCH_PREVIEW_PAGE, revision, document: next.candidate }] : [];
      group = next;
      if (bodyChanged) saved = next.candidate;
      const result: TextPatchResolutionReceipt = { requestId: request.requestId, proposalId: request.proposalId, action: request.action, generation, review: nextReview, pages };
      receipts.set(request.requestId, { input, result, before, after: structuredClone(next), formal: { document: saved, revision } });
      publish({ ...state, document: saved, revision, review: nextReview });
      return result;
    })();
    running.set(request.requestId, { input, promise });
    try { return await promise; } finally { running.delete(request.requestId); }
  };
  const decide = async (request: TextPatchDecision): Promise<TextPatchDecision> => {
    const repeated = decisions.get(request.requestId), input = JSON.stringify(request);
    if (repeated) { if (repeated.input !== input) return fail("请求身份冲突"); return repeated.result; }
    if (receipts.has(request.requestId)) return fail("请求身份冲突");
    const inflight = runningDecisions.get(request.requestId);
    if (inflight) { if (inflight.input !== input) return fail("请求身份冲突"); return inflight.promise; }
    if (running.size || runningDecisions.size) return fail("笔记审阅操作正在处理，请等待原操作结果。");
    const promise = (async () => {
      const review = current(request);
      if ((request.action === "undo" ? review.state !== "accept" : review.state !== "pending") || (request.action !== "reject" && !review.baselineMatches)) return fail();
      let revision = state.revision;
      if (request.action !== "reject" || review.baselineMatches) {
        if (group.manualEdited && request.action !== "accept") return fail("笔记含有新的手动输入，请使用原位置 Undo 保留输入。");
        const next = request.action === "accept" ? group.candidate : group.original;
        revision = await save(next, {baseline: next, origin: "review", requestId: request.requestId, addToHistory: true}); saved = next;
        if (request.action === "accept") group = { ...group, baseline: group.candidate };
      } else group = { original: saved, baseline: saved, candidate: saved };
      decisions.set(request.requestId, { input, result: request });
      publish({ ...state, document: saved, revision, review: shown(group, review, review.generation, request.action, revision) });
      return request;
    })();
    runningDecisions.set(request.requestId, { input, promise });
    try { return await promise; } finally { runningDecisions.delete(request.requestId); }
  };
  return {
    connectHost: next => { host = next; }, prepare: async () => { await host?.flush(); await synchronizeSaved(true); }, resolve, decide,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, snapshot: () => state,
    bindEditor: editor => { port = editor; },
    acknowledgeHbs: (document, baseline, revision) => {
      if (!enabled || document.pageId !== TEXT_PATCH_PREVIEW_PAGE) return;
      if (revision < state.revision) return;
      saved = document;
      if (state.review && ["pending", "accept"].includes(state.review.state)) {
        group = {...group, candidate: document, baseline, manualEdited: true};
        const status = mockNoteReviewChunks(baseline, document).length || state.review.pages.some(page => page.metadataPending) ? "pending" : "accept";
        publish({...state, document, revision, manualEdit: true, review: shown(group, state.review, state.review.generation, status, revision)});
      } else { group = {original: document, candidate: document, baseline}; publish({...state, document, revision}); }
    },
    edit: document => {
      saved = document;
      if (state.review?.state !== "pending") group = { original: saved, baseline: saved, candidate: saved };
      publish({ ...state, document, manualEdit: true, revision: state.revision + 1, review: state.review ? { ...state.review, baselineMatches: false,
        pages:state.review.pages.map(page=>({...page,recovery:{currentRevision:state.revision+1,status:"active"}})) } : null });
    },
    retire: document => {
      saved = document; group = { original: saved, baseline: saved, candidate: saved };
      publish({ ...state, document, revision: state.revision + 1, review: null });
    },
    simulateStaleProposal:()=>{
      requireFixture();
      group={original:saved,baseline:saved,candidate:saved};
      const review=shown(group,{proposalId:`preview-stale-${++serial}`,generation:1,state:"pending",baselineMatches:false,pages:[]});
      publish({...state,review:{...review,pages:review.pages.map(page=>({...page,expectedRevision:Math.max(1,state.revision-1)}))}});
    },
    reset: () => {
      saved = fixture(); group = { original: saved, baseline: saved, candidate: saved }; receipts.clear(); decisions.clear(); running.clear(); runningDecisions.clear(); snapshots.clear(); proposalStates.clear();
      publish({ document: saved, revision: 1, session: state.session + 1, manualEdit: false, review: null, messages: [] });
    },
    read: view => {
      requireFixture();
      const text = renderMockNoteText(view === "candidate" && state.review?.state === "pending" ? group.candidate : saved);
      publish({ ...state, messages: [...state.messages, message("assistant", JSON.stringify({ path: PATH, view }), { kind: "tool-call", toolName: "research_read_file" }),
        message("assistant", JSON.stringify({ path: PATH, name: "研究笔记", text, view }), { kind: "tool-result", toolName: "research_read_file" })] });
      return text;
    },
    patchText: scenario => plan(scenario).patch,
    simulate: async scenario => {
      const { old, next, before, patch } = plan(scenario), previous = state.review?.state === "pending" ? state.review : null;
      const nextGroup = previous ? { ...group, candidate: next } : { original: saved, baseline: old, candidate: next };
      const revision = await save(next, { baseline: nextGroup.baseline, origin: "agent", addToHistory: true });
      group = nextGroup; saved = next;
      const proposalId = previous?.proposalId ?? `preview-note-patch-${++serial}`;
      const generation = (previous?.generation ?? 0) + 1;
      const review = shown(group, { proposalId, generation, baselineMatches: true, state: "pending", pages: [] }, generation, "pending", revision);
      const versions = snapshots.get(proposalId) ?? new Map<number, Group>();
      // Conversation cards compare this tool's input D with its output D.
      // Formal S and the mutable review B remain separate in the live group.
      versions.set(review.generation, structuredClone({ ...group, original: old })); snapshots.set(proposalId, versions);
      publish({ ...state, document: saved, revision, review, messages: [...state.messages,
        message("user", scenario === "rewrite" ? "把研究问题改写得更明确，保留引用和链接。" : "继续补充下一步验证清单。"),
        message("assistant", JSON.stringify({ path: PATH }), { kind: "tool-call", toolName: "research_read_file" }),
        message("assistant", JSON.stringify({ path: PATH, name: "研究笔记", text: before }), { kind: "tool-result", toolName: "research_read_file" }),
        message("assistant", JSON.stringify({ patch }), { kind: "tool-call", toolName: "research_apply_patch" }),
        message("assistant", JSON.stringify({ targets: [{ path: PATH, name: "研究笔记", status: "applied", message: "正文已保存，Diff 待审阅。", proposalId, generation: review.generation }] }), { kind: "tool-result", toolName: "research_apply_patch" }),
        message("assistant", "修改已显示在笔记对应位置。可以逐处 Keep／Undo，或使用顶部 Keep all／Undo all。", { turnFinished: true }),
      ] });
    },
    forPage: async page => enabled && state.review && ["pending", "accept", "reject"].includes(state.review.state) && page === TEXT_PATCH_PREVIEW_PAGE ? [TEXT_PATCH_PREVIEW_CONVERSATION] : [],
    review: async (conversation, proposalId, generation) => {
      if (!enabled || conversation !== TEXT_PATCH_PREVIEW_CONVERSATION) return null;
      const current = proposalId ? proposalStates.get(proposalId) ?? null : state.review;
      if (!current || generation === undefined) return current;
      const frozen = snapshots.get(current.proposalId)?.get(generation);
      return frozen ? { ...shown(frozen, current, generation), state: current.state, baselineMatches: current.baselineMatches,
        operationGeneration: current.operationGeneration ?? current.generation, wholeUndoAvailable: current.wholeUndoAvailable ?? true } : null;
    },
  };
}
