import type { AgentEventPayload } from "@research-assistant/core/agent";
import type { MockIndependentResponse } from "./MockIndependentAgents";
import type { MockSystemDocuments } from "./mockSystemDocuments";
/** Preview tool I/O, driven by a real typed file mention and explicit edit text. */
export function systemDocumentPreviewResponse(documents: MockSystemDocuments): MockIndependentResponse {
    return {
        supports: preview => (preview.input.userInput ?? []).some(input => input.type === "mention" && input.target.kind === "file" && input.target.sourceId === `builtin:${input.target.resourceId}`),
        async run(preview, history, admission, signal) {
            const turnId = preview.turnId;
            const emit = (events: readonly AgentEventPayload[]) => { signal.throwIfAborted(); history.feedbackEvents(admission, events); };
            const say = (text: string) => { const itemId = crypto.randomUUID(); emit([{ type: "itemStarted", turnId, itemId, kind: { type: "assistantMessage" } }, { type: "textDelta", turnId, itemId, text }, { type: "itemCompleted", turnId, itemId }]); };
            const input = (preview.input.userInput ?? []).find(input => input.type === "mention" && input.target.kind === "file" && input.target.sourceId === `builtin:${input.target.resourceId}`);
            if (input?.type !== "mention" || input.target.kind !== "file")
                return;
            const document = await documents.gateway.read(input.target.resourceId);
            const callId = crypto.randomUUID(), itemId = crypto.randomUUID();
            emit([{ type: "itemStarted", turnId, itemId, kind: { type: "toolCall", name: "research_read_file", callId } }, { type: "textDelta", turnId, itemId, text: JSON.stringify({ path: document.path }) }, { type: "itemCompleted", turnId, itemId }]);
            const resultId = crypto.randomUUID();
            emit([{ type: "itemStarted", turnId, itemId: resultId, kind: { type: "toolResult", callId } }, { type: "textDelta", turnId, itemId: resultId, text: JSON.stringify({ path: document.path, text: document.content }) }, { type: "itemCompleted", turnId, itemId: resultId }]);
            const addition = /新增说明[：:]\s*([^\n]+)/u.exec(preview.input.text)?.[1]?.trim();
            if (!addition) {
                say("已读取内置文档。预览中可发送“新增说明：具体内容”，体验逐次授权与 Diff 审阅；不会调用真实模型。");
                return;
            }
            const patchCall = crypto.randomUUID(), patchItem = crypto.randomUUID();
            emit([{ type: "phaseChanged", turnId, phase: "awaitingApproval" }, { type: "itemStarted", turnId, itemId: patchItem, kind: { type: "toolCall", name: "research_apply_patch", callId: patchCall } }, { type: "textDelta", turnId, itemId: patchItem, text: JSON.stringify({ path: document.path, append: addition }) }]);
            let message: string;
            let applied=false;
            try {
                await documents.requestWrite(preview.conversationId, document.id, `${document.content.trimEnd()}\n\n${addition}\n`, signal);
                applied=true;
                message = "修改已保存并立即生效，可打开文档使用现有 Undo／Keep 审阅。";
            }
            catch (reason) {
                signal.throwIfAborted();
                message = reason instanceof Error ? reason.message : "写入失败";
            }
            const resultItem=crypto.randomUUID();
            emit([{ type: "itemCompleted", turnId, itemId: patchItem },
              {type:"itemStarted",turnId,itemId:resultItem,kind:{type:"toolResult",callId:patchCall}},
              {type:"textDelta",turnId,itemId:resultItem,text:JSON.stringify({status:applied?"applied":"failed",targets:[{path:document.path,name:document.name,status:applied?"applied":"failed",message}]})},
              {type:"itemCompleted",turnId,itemId:resultItem},
              { type: "phaseChanged", turnId, phase: "runningModel" }]);
            say(message);
        },
    };
}
