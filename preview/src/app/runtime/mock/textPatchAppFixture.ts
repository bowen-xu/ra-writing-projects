import { writingDemoListMathExample } from "@research-assistant/workbench-preview/writing-demo-markdown-messages";
import { decodeAgentContextPreview, type AgentEventPayload } from "@research-assistant/core/agent";
import { readState, writeState } from "@research-assistant/workbench-preview/browser-notes-storage";
import type { MockIndependentAgents, MockIndependentResponse } from "./MockIndependentAgents";
import type { NotesGateway } from "@research-assistant/data/notes";
import { TEXT_PATCH_PREVIEW_CONVERSATION, TEXT_PATCH_PREVIEW_PAGE, type MockNoteEdit, type MockTextPatchGateway } from "./mockTextPatchGateway";

/** Synthetic data and journal events only. The normal App renders everything. */
export async function seedTextPatchAppFixture(storage: Storage, agents: MockIndependentAgents, patch: MockTextPatchGateway, notes: NotesGateway): Promise<void> {
  if (storage.getItem("text-patch-fixture-seeded") && (await readState()).pages.some(page => page.id === TEXT_PATCH_PREVIEW_PAGE)) return;
  const state = await readState(), now = new Date().toISOString();
  await writeState({ ...state, pages: [...state.pages, { id: TEXT_PATCH_PREVIEW_PAGE, title: "研究笔记", position: state.pages.length,
    status: "active", isFavorite: false, revision: 0, schemaVersion: 1, projectIds: [], tagIds: [], createdAt: now, updatedAt: now }],
    documents: { ...state.documents, [TEXT_PATCH_PREVIEW_PAGE]: { ...patch.snapshot().document, blocks: [] } } });
  await notes.saveDocument({ document: patch.snapshot().document, expectedRevision: 0, saveReason: "manual" });
  const preview = decodeAgentContextPreview({ schemaVersion: 1, conversationId: TEXT_PATCH_PREVIEW_CONVERSATION,
    requestId: crypto.randomUUID(), turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(),
    input: { text: "帮我读取和修改研究笔记。", model: { providerId: "fixture", modelId: "note-edit-preview", revision: "1" }, reasoningEffort: null, context: [] } });
  await agents.seedConversation(preview, "修改研究笔记", `已打开[研究笔记](source://notes/${TEXT_PATCH_PREVIEW_PAGE})。\n\n这是模拟数据。可以在下方输入：\n\n- 改写研究问题\n- 补充验证清单\n- 修改格式示例\n- 读取笔记\n\n修改显示在对应笔记块中，可逐处 Keep／Undo，或使用顶部 Keep all／Undo all。候选支持直接编辑；普通区域的输入会保留。正文和审阅基线自动保存，保存后 Diff 仍保留。左下角可重置预览数据。\n\n公式排版示例：\n\n${writingDemoListMathExample}`);
  storage.setItem("research-assistant:independent-selected", TEXT_PATCH_PREVIEW_CONVERSATION);
  storage.setItem("text-patch-fixture-seeded", "1");
}

/** Bounded mock intents, not a second model or patch interpreter. */
function requestedEdits(text: string): readonly MockNoteEdit[] {
  if (/(?:不要|别|无需|不必|不用|禁止).{0,6}(?:修改|改写|写入|改动|润色)|只(?:读|读取|查看|总结|分析|解释)/u.test(text)) return [];
  if (!/改写|重写|修改|调整|润色|优化|精简|扩写|补充|添加|清单/u.test(text)) return [];
  const scenarios: MockNoteEdit[] = [];
  if (/改写|重写|润色|精简|扩写|(?:修改|调整|优化).{0,5}研究问题/u.test(text)) scenarios.push("rewrite");
  if (/补充|添加|清单/u.test(text)) scenarios.push("checklist");
  if (/格式|公式|表格/u.test(text)) scenarios.push("formats");
  return scenarios.length ? scenarios : ["rewrite"];
}

/** Interruptible pacing belongs to the mock execution adapter, not UI timers. */
function waitForStep(signal: AbortSignal, delayMs = 650): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, delayMs);
    function cancel() { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); }
    signal.addEventListener("abort", cancel, { once: true });
  });
}
export function textPatchPreviewResponse(patch: MockTextPatchGateway): MockIndependentResponse {
  return {
    supports: preview => preview.conversationId === TEXT_PATCH_PREVIEW_CONVERSATION,
    run: async (preview, history, admission, signal) => {
      const turnId = preview.turnId;
      let finishActive: ((output: string) => void) | undefined;
      const emit = (events: readonly AgentEventPayload[]) => { signal.throwIfAborted(); history.feedbackEvents(admission, events); };
      const assistant = (text: string) => {
        const itemId = crypto.randomUUID();
        emit([{ type: "itemStarted", turnId, itemId, kind: { type: "assistantMessage" } },
          { type: "textDelta", turnId, itemId, text }, { type: "itemCompleted", turnId, itemId }]);
      };
      const call = (name: string, args: unknown) => {
        const callId = crypto.randomUUID(), itemId = crypto.randomUUID();
        emit([{ type: "phaseChanged", turnId, phase: "runningTools" },
          { type: "itemStarted", turnId, itemId, kind: { type: "toolCall", callId, name } },
          { type: "textDelta", turnId, itemId, text: JSON.stringify(args) }]);
        const finish = (output: string) => {
          const resultId = crypto.randomUUID();
          emit([{ type: "itemCompleted", turnId, itemId },
            { type: "itemStarted", turnId, itemId: resultId, kind: { type: "toolResult", callId } },
            { type: "textDelta", turnId, itemId: resultId, text: output }, { type: "itemCompleted", turnId, itemId: resultId },
            { type: "phaseChanged", turnId, phase: "runningModel" }]);
          finishActive = undefined;
        };
        finishActive = finish;
        return finish;
      };
      try {
        await patch.prepare(); signal.throwIfAborted();
        const text = preview.input.text, scenarios = requestedEdits(text);
        if (!scenarios.length && !/读取|查看|解释|总结|分析|概述/u.test(text)) {
          assistant("此预览使用预设工具结果。请发送“改写研究问题”“补充验证清单”“修改格式示例”或“读取笔记”，也可组合，例如“请润色这篇笔记并补充验证清单”。"); return;
        }
        const view = "candidate";
        const finishRead = call("research_read_file", { path: `source://notes/${TEXT_PATCH_PREVIEW_PAGE}`, view });
        await waitForStep(signal);
        await patch.prepare(); signal.throwIfAborted();
        const content = patch.read(view);
        finishRead(JSON.stringify({ path: `source://notes/${TEXT_PATCH_PREVIEW_PAGE}`, name: "研究笔记", text: content, view }));
        if (scenarios.length) {
          const finishPatch = call("research_apply_patch", { patch: patch.patchText(scenarios) });
          await waitForStep(signal);
          await patch.prepare(); signal.throwIfAborted();
          await patch.simulate(scenarios);
          const result = [...patch.snapshot().messages].reverse().find(message => message.kind === "tool-result" && message.toolName === "research_apply_patch");
          if (!result) throw new Error("模拟补丁缺少执行回执");
          finishPatch(result.content);
          await waitForStep(signal, 300);
          const formulaExample = scenarios.includes("formats")
            ? "\n\n公式格式示例（模拟数据）：行内 \\(E=mc^2\\)。\n\n\\[\n\\bar{x}=\\frac{1}{n}\\sum_{i=1}^{n}x_i\n\\]\n\n美元分隔符在聊天中按文字显示：$x$、$$y$$。"
            : "";
          assistant(`修改已保存并显示在对应笔记块中，Diff 保留待审阅。可逐处 Keep／Undo，或使用顶部 Keep all／Undo all。${formulaExample}`);
        } else {
          const state = patch.snapshot(), document = state.review?.pages[0]?.afterDocument ?? state.document;
          const question = document.blocks.find(block => block.id === "preview-argument");
          const focus = question?.content.kind === "inline" ? question.content.items
            .map(item => item.type === "text" ? item.text : "").join("") : "笔记围绕逻辑视觉识别中的证据整合展开。";
          const nextSteps = document.blocks.some(block => block.id === "preview-check-heading")
            ? "\n\n下一步验证包括噪声与遮挡条件，以及局部证据对判断的影响。" : "";
          assistant(`这份《研究笔记》的研究问题是：${focus}\n\n笔记保留了相关文献与方法链接，并用标题、行内与块级公式、表格、引用、清单和代码整理实验思路。表格数值为模拟数据，仅用于预览。${nextSteps}`);
        }
      } catch (reason) {
        if (signal.aborted) return;
        const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason
          : reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string" ? reason.message : "模拟工具执行失败";
        const code = reason && typeof reason === "object" && "code" in reason && typeof reason.code === "string" ? reason.code : "note_preview_tool_failed";
        const message = `${detail}（错误码：${code}）`;
        finishActive?.(JSON.stringify({ status: "failed", message }));
        assistant(message);
        throw reason;
      }
    },
  };
}
