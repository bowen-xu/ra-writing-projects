/** @vitest-environment happy-dom */
import { mocks, workspace, id, buttonByText, submissionContext, WritingAgentRuntimePanel } from "./WritingAgentRuntimePanel.test-harness";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { WritingFileSessions } from "./editor/writingFileSessions";
import { captureWritingEditor } from "./editor/editorSession";
import { notify } from "../../../../../apps/web/src/core/public/feedback";
import type { AgentWritingQueueResponse } from "@research-assistant/core/agent";
import {acquireWritingSubmissionController, forgetWritingSubmissionController} from "../../../../../apps/web/src/core/features/agent/writingSubmissionController";
async function retryWorkspace(): Promise<void> {
  const actions = vi.mocked(notify.error).mock.calls.at(-1)?.[1]?.actions;
  expect(actions?.find(action => action.label === "重新发送")).toBeDefined();
  await act(async () => actions!.find(action => action.label === "重新发送")!.onClick());
}

it.each([{ keep: false, active: false }, { keep: true, active: false }, { keep: false, active: true }, { keep: true, active: true }])("freezes latest file buffers across conversation switches (%j)", async ({ keep, active }) => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const files = new WritingFileSessions(), first = files.open({ manuscriptId: id, relativePath: "main.tex" }, "original", "disk-main");
  first.applyAgent("previous-turn", 0, "latest proposal");
  if (keep) first.resolveAll("keep");
  const other = files.open({ manuscriptId: id, relativePath: "other.tex" }, "other", "disk-other");
  other.dispatch({ changes: { from: 0, insert: "unsaved " }, userEvent: "input.type" });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  mocks.prepareWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: request.conversationId,
    requestId: request.requestId, manuscriptId: id, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: request.conversationId,
    requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  const admitted = vi.fn();
  async function send(conversationId: string): Promise<void> {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={conversationId} conversationTitle="Paper"
      activePath={active ? "main.tex" : undefined} content={first.read().content} contentHash={first.savedSha256}
      readEditorSnapshot={() => captureWritingEditor(first.state, `${id}:main.tex`)} readFileBuffers={() => files.readBuffers(id)}
      files={["main.tex", "other.tex"].map((path) => ({ manuscriptId: id, relativePath: parseManuscriptPath(path), kind: "tex" as const,
        sha256: "stale-list-hash", sizeBytes: 8, modifiedAt: "now" }))}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} onSubmissionAdmitted={admitted} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Continue editing");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  try {
    await send(id);
    const expected = [
      { relativePath: "main.tex", expectedDiskSha256: "disk-main", buffer: { text: "latest proposal" } },
      { relativePath: "other.tex", expectedDiskSha256: "disk-other", buffer: { text: "unsaved other" } },
    ];
    expect(mocks.prepareWriting.mock.calls[0]?.[0].context.files).toMatchObject(active ? expected.slice(0, 1) : expected);
    expect(workspace.prepare.mock.calls[0]?.[0].buffers).toEqual(files.readBuffers(id));
    first.dispatch({ changes: { from: first.state.doc.length, insert: " manual" }, userEvent: "input.type" });
    await send("22222222-2222-4222-8222-222222222222");
    expect(mocks.prepareWriting.mock.calls[1]?.[0].context.files[0].buffer.text).toBe("latest proposal manual");
    expect(workspace.prepare.mock.calls[1]?.[0].buffers).toEqual(files.readBuffers(id));
    expect(first.read().reviewBaseline).toBe(keep ? "latest proposal manual" : "original");
    expect(admitted).toHaveBeenCalledTimes(2);
    expect(admitted.mock.calls[1]?.[0].scope.conversationId).toBe("22222222-2222-4222-8222-222222222222");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each([null, { documentKey: "other:main.tex", sessionId: id, revision: id, text: "source" },
  { documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "older" }])("does not prepare stale or unavailable live editor content: %j", async (snapshot) => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => snapshot}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Question");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Question");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each([
  ["deepseek", "deepseek-v4-pro", null, "deepSeekNonThinking", false],
  ["openai", "gpt-5.6-terra", null, "chatGptDefault", false],
  ["openai", "gpt-5.6-terra", null, "chatGptDefault", true],
  ["openai", "gpt-5.6-sol", null, "chatGptDefault", false],
  ...["low", "medium", "high", "xhigh", "max"].map(effort => ["openai", "gpt-5.6-terra", effort, "chatGptDefault", false] as const),
  ["openai", "gpt-5.6-terra", "ultra", null, false],
  ["openai", "gpt-5.6-terra", "unknown", null, false],
  ["deepseek", "deepseek-v4-pro", "medium", null, false],
] as const)("previews and admits only supported configuration %s/%s/%s", async (providerId, modelId, reasoningEffort, mode, withInstructions) => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let liveText = "Unsaved source";
  mocks.prepareWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id, requestId: request.requestId,
    manuscriptId: id, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId, modelId, revision: null }, reasoningEffort,
      ...(withInstructions ? { instructionConfigs: [{ environment_id: "paper", layers: [{ origin: { tier: "user", source_id: "agent/config.toml", revision: "config-v1" }, instructions: { max_bytes: 4096, fallback_filenames: [] } }] }] } : {}),
      ...(withInstructions ? { instructions: [{ environmentId: "paper", scopeId: ".", sourceId: "AGENTS.md", revision: "v1", originalBytes: 4, text: "Rule", disposition: "included" }] } : {}),
      context: [{ sourceId: "source", kind: "manuscript", resourceId: "main.tex", revision: "hash", anchor: JSON.stringify({manuscriptId: id}), text: request.context.files[0].buffer.text }] } }));
  mocks.startWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: withInstructions, outcome: withInstructions ? "completed" : null }));
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="Unsaved source" contentHash="disk-hash"
      readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: liveText,
        selection: { startUtf16: 0, endUtf16: 4 } })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "disk-hash", sizeBytes: 3, modifiedAt: "now" }]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Explain");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.prepareWriting.mock.calls.at(-1)?.[0].context.files[0].buffer.text).toBe("Unsaved source");
    expect(mocks.prepareWriting.mock.calls.at(-1)?.[0].context.files[0].buffer.revision).toBe(id);
    expect(mocks.prepareWriting.mock.calls.at(-1)?.[0].context.files[0].selection).toEqual({ startUtf16: 0, endUtf16: 4 });
    if (mode === null) {
      expect(mocks.startWriting).not.toHaveBeenCalled();
      expect(textarea.value).toBe("Explain");
      expect(container.querySelector('[aria-label="发送恢复"]')).toBeNull();
      expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("请重新选择模型"), expect.objectContaining({dismissible: false}));
      return;
    }
    expect(mocks.startWriting).toHaveBeenCalledTimes(1);
    expect(workspace.prepare).toHaveBeenCalledOnce();
    expect(workspace.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.startWriting.mock.invocationCallOrder[0]!);
    expect(mocks.startWriting.mock.calls[0]?.[0].mode).toBe(mode);
    expect(textarea.value).toBe("");
    if (withInstructions) {
      expect(mocks.prepareWriting.mock.calls[0]?.[0].context.files[0].buffer.text).toBe("Unsaved source");
    }
    expect(container.textContent).not.toContain("确认发送内容");
    if (withInstructions) {
      // A controller completion is not a durable transcript turn. Wait for
      // history ownership instead of showing the latest proposal globally.
      expect(buttonByText("查看 diff")).toBeUndefined();
      expect(container.querySelector('summary[aria-label="更多会话操作"]')).toBeNull();
    } else expect(container.querySelector('[aria-label="停止生成"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not start a writing turn until its editable copy is ready", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  workspace.prepare.mockRejectedValueOnce(new Error("workspace unavailable"));
  workspace.restore.mockRejectedValueOnce("notFound");
  mocks.prepareWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id,
    manuscriptId: id, requestId: request.requestId, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id,
    requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  mocks.steer.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: request.conversationId, turnId: request.turnId, inputId: request.inputId }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Edit the abstract");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(workspace.prepare).toHaveBeenCalledOnce();
    expect(mocks.startWriting).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Edit the abstract");
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    await act(async () => {await Promise.resolve();});
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    await retryWorkspace();
    expect(workspace.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.startWriting).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("recovers the original submission after switching while its editable copy is being prepared", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const second = "22222222-2222-4222-8222-222222222222";
  let resolveWorkspace!: () => void;
  workspace.prepare.mockRejectedValueOnce(new Error("workspace unavailable"));
  workspace.restore.mockRejectedValueOnce("notFound");
  workspace.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { resolveWorkspace = resolve; }));
  mocks.read.mockImplementation(async (): Promise<AgentWritingQueueResponse> => ({ schemaVersion: 1, conversationId: id,
    manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: [] }));
  mocks.prepareWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id,
    manuscriptId: id, requestId: request.requestId, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id,
    requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (conversationId: string) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={conversationId} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash"
    readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
    files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
    messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />);
  const type = async (text: string) => {
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  try {
    await act(async () => render(id));
    await type("Edit the abstract");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.startWriting).not.toHaveBeenCalled();
    const actions = vi.mocked(notify.error).mock.calls.at(-1)?.[1]?.actions;
    await act(async () => {void actions!.find(action => action.label === "重新发送")!.onClick();});
    const originalRequestId = mocks.prepareWriting.mock.calls.at(-1)?.[0].requestId;
    expect(workspace.prepare).toHaveBeenCalledTimes(2);
    await act(async () => render(second));
    await type("Keep the second conversation draft");
    await act(async () => { resolveWorkspace(); await Promise.resolve(); });
    expect(mocks.startWriting).toHaveBeenCalledOnce();
    expect(mocks.startWriting.mock.calls[0]?.[0]).toMatchObject({ conversationId: id, requestId: originalRequestId });
    expect(container.querySelector("textarea")!.value).toBe("Keep the second conversation draft");
    await act(async () => render(id));
    const isRecovery = (action: unknown): action is {label: string; onClick: () => void | Promise<void>} => !!action && typeof action === "object"
      && "label" in action && action.label === "重试本机恢复" && "onClick" in action && typeof action.onClick === "function";
    await vi.waitFor(() => expect(vi.mocked(notify.error).mock.calls.some(([, options]) => isRecovery(options?.action))).toBe(true));
    const recovery = [...vi.mocked(notify.error).mock.calls].reverse().map(([, options]) => options?.action)
      .find(isRecovery);
    if (!recovery) throw new Error("Missing local recovery action");
    await act(async () => { await recovery.onClick(); });
    await vi.waitFor(() => expect(container.querySelector("textarea")!.value).toBe(""));
    expect(mocks.startWriting).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("a late workspace result for O1 cannot confirm O2 in the same production owner", async () => {
  vi.clearAllMocks(); let finish!: () => void;
  workspace.prepare.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
  mocks.read.mockResolvedValue({schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []});
  mocks.prepareWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id, manuscriptId: id, requestId: request.requestId,
    turnId: id, contextSnapshotId: id, input: {text: request.text, model: {providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null}, reasoningEffort: null, context: submissionContext(request)}}));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const key = JSON.stringify(["desktop", id, id]); let owner: ReturnType<typeof acquireWritingSubmissionController> | undefined;
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper" activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
      files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined}/>));
    const textarea = host.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "first request"); textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(workspace.prepare).toHaveBeenCalledOnce(); owner = acquireWritingSubmissionController(key, mocks, mocks, mocks);
    const original = owner.getSnapshot().preview!.requestId, replacement = crypto.randomUUID();
    await act(async () => {await owner!.abandonWritingPreparation(); await owner!.prepare({conversationId: id, requestId: replacement, text: "replacement request",
      context: {manuscriptId: id, files: [{relativePath: "main.tex", expectedDiskSha256: "hash"}]}});});
    expect(replacement).not.toBe(original); await act(async () => {finish(); await Promise.resolve();});
    expect(mocks.startWriting).not.toHaveBeenCalled(); expect(owner.getSnapshot().preview?.requestId).toBe(replacement);
  } finally {await act(async () => root.unmount()); if (owner) forgetWritingSubmissionController(key, owner); host.remove();}
});
