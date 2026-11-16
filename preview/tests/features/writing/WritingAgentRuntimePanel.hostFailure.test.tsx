/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {id, WritingAgentRuntimePanel} from "./WritingAgentRuntimePanel.test-harness.tsx";

it("shows file-owner failures in chat without an indefinite preparation overlay", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host), retry = vi.fn();
  const render = (failure: boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id}
    activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={null}
    historyReady={!failure} open onOpenChange={() => undefined}
    {...(failure ? {hostFailure: {content: "稿件读取失败，请重试。", diagnosticText: "code=unavailable", retry}} : {})}/>);
  try {
    await act(async () => render(true));
    const error = host.querySelector<HTMLElement>('[role="alert"][aria-label="稿件读取失败"]');
    expect(error?.textContent).toContain("稿件读取失败，请重试。");
    expect(error?.querySelector('[aria-label="复制诊断信息"]')).not.toBeNull();
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).not.toContain("准备中");
    expect(host.querySelector(".agent-composer-preparing-state")).toBeNull();
    const retryButton = [...error!.querySelectorAll("button")].find(button => button.textContent === "重新读取")!;
    await act(async () => retryButton.click()); expect(retry).toHaveBeenCalledOnce();
    await act(async () => render(false));
    expect(host.querySelector('[role="alert"][aria-label="稿件读取失败"]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(false);
  } finally {await act(async () => root.unmount()); host.remove();}
});

it("shows a non-retryable recovery error without inventing a retry action", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id}
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]} projection={null}
      historyReady={false} open onOpenChange={() => undefined} hostFailure={{content: "请重新打开工作区。", diagnosticText: "code=checkpoint_unavailable"}}/>));
    const error = host.querySelector<HTMLElement>('[role="alert"][aria-label="稿件读取失败"]')!;
    expect(error.textContent).toContain("请重新打开工作区。");
    expect([...error.querySelectorAll("button")].some(button => button.textContent === "重新读取")).toBe(false);
  } finally {await act(async () => root.unmount()); host.remove();}
});
