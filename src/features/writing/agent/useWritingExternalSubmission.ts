import {useEffect, useRef, type RefObject} from "react";
import type { AgentUserInput } from "@research-assistant/core/agent";
import { useAgentCanvasExternalSubmission } from "@research-assistant/workbench-sdk/agent-canvas";
import type { WritingAgentSubmitOptions } from "@research-assistant/workbench-sdk/agent-presentation";
import {useWritingRuntimeAdmission} from "../persistence/writingRuntimeAdmission";

/** Reader actions share the current conversation and leave its composer draft intact. */
export function useWritingExternalSubmission({blocked, controller, submit, readModel, messageRequest, ready = true}: {
  readonly messageRequest?: import("@research-assistant/workbench-sdk/agent-ui").AgentCanvasMessage | null;
  readonly ready?: boolean;
  readonly blocked: boolean;
  readonly readModel?: () => WritingAgentSubmitOptions["modelSelection"];
  readonly controller: RefObject<{getSnapshot(): {readonly phase: string; readonly preview: {readonly requestId: string} | null}} | null>;
  readonly submit: (text: string, options: WritingAgentSubmitOptions) => Promise<void>;
}): void {
  const admission = useWritingRuntimeAdmission();
  const send: Parameters<typeof useAgentCanvasExternalSubmission>[0] = async (text, resources = []) => {
    if (admission.isDisabled()) throw Object.assign(new Error("WRITING_RUNTIME_DISABLED：写作插件当前不可接纳新请求。"), {code: "WRITING_RUNTIME_DISABLED"});
    if (blocked) throw new Error("当前对话正在处理请求或需要恢复，请稍后重试。");
    const before = controller.current?.getSnapshot().preview?.requestId;
    const userInput: readonly AgentUserInput[] = [{type:"text",text,textElements:[]}, ...resources.map(resource => ({type:"mention" as const,name:resource.resourceId,target:{kind:"file" as const,sourceId:"context:"+JSON.stringify(resource),resourceId:resource.resourceId}}))];
    const modelSelection = readModel?.();
    if (admission.isDisabled()) throw Object.assign(new Error("WRITING_RUNTIME_DISABLED：写作插件当前不可接纳新请求。"), {code: "WRITING_RUNTIME_DISABLED"});
    await submit(text,{contextScope:"current-file",userInput,...(modelSelection ? {modelSelection} : {})});
    const accepted = controller.current?.getSnapshot();
    if (accepted?.phase !== "started" || accepted.preview?.requestId === before) throw new Error("消息未接纳，请在聊天窗核对状态后重试。");
  };
  useAgentCanvasExternalSubmission(send);
  const consumed = useRef<typeof messageRequest>(undefined);
  useEffect(() => {
    if (!ready || !messageRequest || consumed.current === messageRequest) return;
    consumed.current = messageRequest;
    void send(messageRequest.text, messageRequest.resources, messageRequest.options).then(messageRequest.resolve, messageRequest.reject);
  }, [messageRequest, ready]);
}
