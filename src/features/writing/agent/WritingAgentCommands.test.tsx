/** @vitest-environment happy-dom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WritingAgentPanel } from "../../../../../../apps/web/src/core/features/agent/presentation/WritingAgentPanel";
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
import type { AgentCommandGateway, AgentCompactResult } from "../../../../../../apps/web/src/core/features/agent/agentCommandGateway";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });

it.each([false, true])("queues commands while running and rejects direct command steering (running=%s)", async isRunning => {
  const onSubmit = vi.fn(), onQueue = vi.fn(), onSteer = vi.fn();
  const info = vi.spyOn(notify, "info").mockReturnValue(1);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<StrictMode><WritingAgentPanel open isRunning={isRunning}
    onSubmit={onSubmit} onQueue={onQueue} onSteer={onSteer} /></StrictMode>));
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "/compact");
    input.setSelectionRange(8, 8); input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click());
  expect(info).toHaveBeenCalledTimes(isRunning ? 0 : 1);
  expect(onQueue).toHaveBeenCalledTimes(isRunning ? 1 : 0);
  if (isRunning) expect(onQueue).toHaveBeenCalledWith("/compact");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(info).toHaveBeenCalledTimes(isRunning ? 0 : 2);
  expect(onSubmit).not.toHaveBeenCalled(); expect(onSteer).not.toHaveBeenCalled();
  expect(input.value).toBe("/compact");
});

async function mountCommandPanel(gateway: AgentCommandGateway) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onSubmit = vi.fn(), onQueue = vi.fn(), onSteer = vi.fn();
  await act(async () => root.render(<StrictMode><WritingAgentPanel open commandGateway={gateway}
    resourceScope={{ kind: "manuscript", resourceId: "manuscript", conversationId: "conversation" }}
    onSubmit={onSubmit} onQueue={onQueue} onSteer={onSteer} /></StrictMode>));
  async function type(value: string) {
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await type("/compact");
  return { host, type, onSubmit, onQueue, onSteer,
    send: () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click()) };
}
function pendingGateway() {
  let resolve!: (result: AgentCompactResult) => void, reject!: (error: Error) => void;
  const promise = new Promise<AgentCompactResult>((yes, no) => { resolve = yes; reject = no; });
  const gateway: AgentCommandGateway = {
    readUsage: vi.fn(async () => ({ inputTokens: 82000, contextWindowTokens: 128000 })),
    compact: vi.fn(() => promise),
  };
  return { gateway, resolve, reject };
}
const compactResult = { beforeTokens: 82000, usage: { inputTokens: 18000, contextWindowTokens: 128000 } };

it("shows shared progress, prevents duplicate commands and updates context usage from the adapter", async () => {
  const backend = pendingGateway(), success = vi.spyOn(notify, "success").mockReturnValue(1);
  const view = await mountCommandPanel(backend.gateway);
  await view.send();
  expect(view.host.querySelector('textarea')!.value).toBe("");
  await view.type("/compact"); await view.send();
  expect(backend.gateway.compact).toHaveBeenCalledOnce();
  expect(view.host.querySelector('.agent-compaction-activity')?.textContent).toBe("正在压缩上下文");
  expect(view.host.querySelector('.writing-agent-transcript .agent-compaction-activity')).not.toBeNull();
  expect(view.host.querySelector('.writing-agent-composer .agent-compaction-activity')).toBeNull();
  expect(view.host.querySelector('.agent-compaction-activity time, .agent-compaction-activity button, .agent-compaction-activity details')).toBeNull();
  expect(view.host.querySelector('textarea')!.value).toBe("/compact");
  await act(async () => backend.resolve(compactResult));
  expect(view.host.querySelector('.writing-agent-transcript .agent-compaction-activity')?.textContent).toBe("上下文已压缩");
  expect(view.host.querySelector('textarea')!.value).toBe("/compact");
  expect(view.host.querySelector<HTMLElement>('.writing-agent-context-ring')!.style.getPropertyValue('--writing-agent-context-progress')).toBe("50.4deg");
  expect(success).not.toHaveBeenCalled();
  expect(view.onSubmit).not.toHaveBeenCalled(); expect(view.onQueue).toHaveBeenCalledExactlyOnceWith("/compact"); expect(view.onSteer).not.toHaveBeenCalled();
});
it("keeps a newer draft when compaction completes", async () => {
  const backend = pendingGateway(); vi.spyOn(notify, "success").mockReturnValue(1);
  const view = await mountCommandPanel(backend.gateway); await view.send(); await view.type("接着检查摘要");
  await act(async () => backend.resolve(compactResult));
  expect(view.host.querySelector('textarea')!.value).toBe("接着检查摘要");
});
it("does not queue or steer ordinary text on Tab during compaction", async () => {
  const backend = pendingGateway();
  const view = await mountCommandPanel(backend.gateway); await view.send(); await view.type("压缩期间的草稿");
  const input = view.host.querySelector("textarea")!;
  const event = new KeyboardEvent("keydown", {key: "Tab", bubbles: true, cancelable: true});
  await act(async () => input.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true); expect(input.value).toBe("压缩期间的草稿");
  expect(view.onSubmit).not.toHaveBeenCalled(); expect(view.onQueue).not.toHaveBeenCalled(); expect(view.onSteer).not.toHaveBeenCalled();
  expect(backend.gateway.compact).toHaveBeenCalledOnce();
});
it("retains the command and existing usage after failure", async () => {
  const backend = pendingGateway(), error = vi.spyOn(notify, "error").mockReturnValue(1);
  const view = await mountCommandPanel(backend.gateway); await view.send();
  await act(async () => backend.reject(new Error("mock failure")));
  expect(view.host.querySelector('textarea')!.value).toBe("/compact");
  expect(view.host.querySelector('.agent-compaction-activity')?.textContent).toBe("上下文压缩失败");
  expect(view.host.querySelector<HTMLElement>('.writing-agent-context-ring')!.style.getPropertyValue('--writing-agent-context-progress')).toBe("230.4deg");
  expect(error).toHaveBeenCalledWith("上下文压缩失败，草稿和对话保留，请重试。");
});
it("does not replace a newer draft with a failed command", async () => {
  const backend = pendingGateway(); vi.spyOn(notify, "error").mockReturnValue(1);
  const view = await mountCommandPanel(backend.gateway); await view.send(); await view.type("继续检查来源");
  await act(async () => backend.reject(new Error("mock failure")));
  expect(view.host.querySelector('textarea')!.value).toBe("继续检查来源");
});
it("aborts on unmount and ignores late adapter completion", async () => {
  const backend = pendingGateway(), success = vi.spyOn(notify, "success").mockReturnValue(1);
  const view = await mountCommandPanel(backend.gateway); await view.send();
  const request = vi.mocked(backend.gateway.compact).mock.calls[0]![0];
  await act(async () => root.unmount());
  expect(request.signal.aborted).toBe(true);
  await act(async () => backend.resolve(compactResult));
  expect(success).not.toHaveBeenCalled();
});
