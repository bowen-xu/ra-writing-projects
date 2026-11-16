/** @vitest-environment happy-dom */
import { mocks, workspace, id, runningProjection, buttonByText, submissionContext, WritingAgentRuntimePanel } from "./WritingAgentRuntimePanel.test-harness.tsx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { AgentQueueProvider } from "@research-assistant/workbench-preview/agent-queue-provider";
import { AgentDraftProvider } from "@research-assistant/workbench-preview/agent-draft-provider";
import { ConversationDraftStore } from "@research-assistant/workbench-preview/conversation-draft-store";
import { resetWritingSubmissionControllersForTests } from "@research-assistant/workbench-preview/writing-submission-controller";
import { AgentSteeringProvider } from "@research-assistant/workbench-preview/agent-steering-provider";
import { notify } from "@research-assistant/workbench-preview/feedback";
import { getAppStorage } from "@research-assistant/workbench-preview/app-storage";
import { registerStoragePersistence } from "@research-assistant/workbench-preview/storage-persistence";
import type { AgentConversationProjection, AgentWorkspaceBuffer, AgentWritingQueueResponse } from "@research-assistant/core/agent";
import type { WritingAgentMessage } from "@research-assistant/workbench-preview/writing-agent-panel";

it("does not expose terminal-turn steer recovery", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]}
      projection={{ conversationId: id, seq: 2, activeTurn: null, turnOrder: [id], turns: new Map([[id, {
        contextSnapshotId: id, model: { providerId: "openai", modelId: "gpt-5.6-terra", revision: null },
        phase: "preparing", outcome: "canceled", itemOrder: [], items: new Map(), attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null,
      }]]) }} historyReady open onOpenChange={() => undefined} />));
    expect(buttonByText("找回未处理的补充说明")).toBeUndefined();
    expect(mocks.readWritingRecovery).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not show an empty task area while the queue is being read", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let resolveRead!: (queue: AgentWritingQueueResponse) => void;
  mocks.read.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" files={[]} messages={[]}
      projection={null} historyReady open onOpenChange={() => undefined} />));
    expect(mocks.read).toHaveBeenCalled();
    expect(container.querySelector(".writing-agent-task-stack")).toBeNull();
    await act(async () => resolveRead({schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0,
      paused: false, preparingInputId: null, inputs: []}));
    expect(container.querySelector(".writing-agent-task-stack")).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("shows the submitted message and locks input until the turn is admitted", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const queue: AgentWritingQueueResponse = {schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []};
  mocks.read.mockResolvedValue(queue);
  let resolveBuffers!: (buffers: AgentWorkspaceBuffer[]) => void;
  const buffers = new Promise<AgentWorkspaceBuffer[]>(resolve => {resolveBuffers = resolve;});
  let resolveStart!: (response: {schemaVersion: 1; conversationId: string; requestId: string; turnId: string; alreadyStarted: boolean; outcome: null}) => void;
  mocks.prepareWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id, manuscriptId: id, requestId: request.requestId,
    turnId: id, contextSnapshotId: id, input: {text: request.text, model: {providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null},
      reasoningEffort: null, context: submissionContext(request)}}));
  mocks.startWriting.mockImplementation(() => new Promise(resolve => {resolveStart = resolve;}));
  const props = {manuscriptId: id, conversationId: id, conversationTitle: "Paper", activePath: "main.tex", content: "source", contentHash: "hash",
    files: [{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex" as const, sha256: "hash", sizeBytes: 6, modifiedAt: "now"}],
    messages: [] as WritingAgentMessage[], projection: null, historyReady: true, open: true, onOpenChange: () => undefined,
    readEditorSnapshot: () => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"}), readFileBuffers: () => buffers};
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel {...props} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Question");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(container.querySelector('[data-pending-submission="true"]')?.textContent).toContain("Question");
    expect(textarea.disabled).toBe(true);
    await act(async () => {resolveBuffers([{path: "main.tex", expectedDiskSha256: "hash", sessionId: id, revision: id, text: "source"}]);});
    expect(mocks.prepareWriting, JSON.stringify(vi.mocked(notify.error).mock.calls)).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.startWriting).toHaveBeenCalledOnce());
    expect(textarea.disabled).toBe(true);
    const request = mocks.startWriting.mock.calls[0]![0];
    await act(async () => resolveStart({schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null}));
    expect(textarea.disabled).toBe(false);
    expect(container.querySelector('[data-pending-submission="true"]')).not.toBeNull();
    await act(async () => root.render(<WritingAgentRuntimePanel {...props} messages={[{id: "user-item", conversationId: id, turnId: id,
      role: "user", content: "Question", streaming: false}]} />));
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
  } finally {await act(async () => root.unmount()); container.remove();}
});

it("keeps the editor covered until the admitted submission finishes acknowledging its original draft", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const queue: AgentWritingQueueResponse = {schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []};
  mocks.read.mockResolvedValue(queue);
  mocks.prepareWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id, manuscriptId: id, requestId: request.requestId,
    turnId: id, contextSnapshotId: id, input: {text: request.text, model: {providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null},
      reasoningEffort: null, context: submissionContext(request)}}));
  mocks.startWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null}));
  let releaseDraft!: () => void;
  const draftGate = new Promise<void>(resolve => {releaseDraft = resolve;});
  const consume = ConversationDraftStore.prototype.consumeAcknowledgment;
  const consumeSpy = vi.spyOn(ConversationDraftStore.prototype, "consumeAcknowledgment").mockImplementation(async function (this: ConversationDraftStore, token, scope) {
    await draftGate;
    return consume.call(this, token, scope);
  });
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
      files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Question");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    await vi.waitFor(() => expect(consumeSpy).toHaveBeenCalledOnce());
    expect(mocks.startWriting).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("Question");
    expect(textarea.disabled).toBe(true);
    expect(container.querySelector(".agent-composer-input-state")?.classList.contains("is-preparing")).toBe(true);
    await act(async () => releaseDraft());
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    await vi.waitFor(() => expect(textarea.disabled, container.textContent ?? "").toBe(false));
  } finally {
    releaseDraft(); consumeSpy.mockRestore();
    await act(async () => root.unmount()); container.remove();
  }
});

it("stops a send during local file capture without dispatching its late result", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  mocks.read.mockResolvedValue({schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []});
  let finishBuffers!: (buffers: AgentWorkspaceBuffer[]) => void;
  const buffers = new Promise<AgentWorkspaceBuffer[]>(resolve => {finishBuffers = resolve;});
  const readFileBuffers = vi.fn(() => buffers);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readFileBuffers={readFileBuffers}
      readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
      files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Question");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    await vi.waitFor(() => expect(readFileBuffers).toHaveBeenCalledOnce());
    expect(textarea.disabled).toBe(true);
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="停止发送"]')!;
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe("Question");
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    await act(async () => finishBuffers([{path: "main.tex", expectedDiskSha256: "hash", sessionId: id, revision: id, text: "source"}]));
    expect(mocks.prepareWriting).not.toHaveBeenCalled();
    expect(mocks.startWriting).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Question");
  } finally {finishBuffers([]); await act(async () => root.unmount()); container.remove();}
});

it("stops an in-flight preparation by retaining its original identity until the late result is retired", async () => {
  vi.clearAllMocks();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  mocks.read.mockResolvedValue({schemaVersion:1,conversationId:id,manuscriptId:id,revision:0,paused:false,preparingInputId:null,inputs:[]});
  let finishPrepare!: () => void;
  const prepareGate = new Promise<void>(resolve => {finishPrepare=resolve;});
  mocks.prepareWriting.mockImplementation(async request => {await prepareGate;return {schemaVersion:1,conversationId:id,manuscriptId:id,requestId:request.requestId,
    turnId:id,contextSnapshotId:id,input:{text:request.text,model:{providerId:"deepseek",modelId:"deepseek-v4-pro",revision:null},reasoningEffort:null,context:submissionContext(request)}};});
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})}
      files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined}/>));
    const textarea=container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"Question");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await vi.waitFor(() => expect(mocks.prepareWriting).toHaveBeenCalledOnce());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="停止发送"]')!.click());
    expect(textarea.disabled).toBe(true);
    expect(container.textContent).toContain("正在停止发送");
    expect(mocks.startWriting).not.toHaveBeenCalled();
    await act(async () => finishPrepare());
    await vi.waitFor(() => expect(textarea.disabled, container.textContent ?? "").toBe(false));
    expect(textarea.value).toBe("Question");
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally {finishPrepare();await act(async () => root.unmount());container.remove();}
});

it("offers original-request recovery instead of an endless stopping mask when the preparation outcome is unknown", async () => {
  vi.clearAllMocks();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  mocks.read.mockResolvedValue({schemaVersion:1,conversationId:id,manuscriptId:id,revision:0,paused:false,preparingInputId:null,inputs:[]});
  let rejectPrepare!: (reason: Error) => void;
  mocks.prepareWriting.mockImplementation(() => new Promise((_, reject) => {rejectPrepare=reject;}));
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})}
      files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined}/>));
    const textarea=container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"Question");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await vi.waitFor(() => expect(mocks.prepareWriting).toHaveBeenCalledOnce());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="停止发送"]')!.click());
    await act(async () => rejectPrepare(new Error("lost response")));
    await vi.waitFor(() => expect(container.textContent).toContain("无法确认发送已停止"));
    expect(container.textContent).not.toContain("正在停止发送");
    expect(container.textContent).toContain("；R=");
    expect(textarea.value).toBe("Question");
    expect(container.querySelector('[data-pending-submission="true"]')?.textContent).toContain("Question");
    await act(async () => buttonByText("重新读取")!.click());
    expect(mocks.prepareWriting).toHaveBeenCalledOnce();
    expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally {await act(async () => root.unmount());container.remove();}
});

it("removes the provisional message after a definite preparation rejection and preserves the draft", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  mocks.read.mockResolvedValue({schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []});
  mocks.prepareWriting.mockRejectedValueOnce("invalidInput");
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
      files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Question");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    expect(textarea.value).toBe("Question");
    expect(textarea.disabled).toBe(false);
  } finally {await act(async () => root.unmount()); container.remove();}
});

it("keeps the input locked when history arrives before the start receipt", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  mocks.read.mockResolvedValue({schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []});
  mocks.prepareWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id, manuscriptId: id, requestId: request.requestId,
    turnId: id, contextSnapshotId: id, input: {text: request.text, model: {providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null},
      reasoningEffort: null, context: submissionContext(request)}}));
  let resolveStart!: (response: {schemaVersion: 1; conversationId: string; requestId: string; turnId: string; alreadyStarted: boolean; outcome: null}) => void;
  mocks.startWriting.mockImplementation(() => new Promise(resolve => {resolveStart = resolve;}));
  const props = {manuscriptId: id, conversationId: id, conversationTitle: "Paper", activePath: "main.tex", content: "source", contentHash: "hash",
    files: [{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex" as const, sha256: "hash", sizeBytes: 6, modifiedAt: "now"}],
    messages: [] as WritingAgentMessage[], projection: null, historyReady: true, open: true, onOpenChange: () => undefined,
    readEditorSnapshot: () => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})};
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel {...props} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Question");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    await vi.waitFor(() => expect(mocks.startWriting).toHaveBeenCalledOnce());
    await act(async () => root.render(<WritingAgentRuntimePanel {...props} messages={[{id: "user-item", conversationId: id, turnId: id,
      role: "user", content: "Question", streaming: false}]} />));
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    expect(textarea.disabled).toBe(true);
    const request = mocks.startWriting.mock.calls[0]![0];
    await act(async () => resolveStart({schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null}));
    expect(textarea.disabled).toBe(false);
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
  } finally {await act(async () => root.unmount()); container.remove();}
});

it("keeps the original provisional message and locks input while a preparation result is unknown", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let queue: AgentWritingQueueResponse = {schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []};
  mocks.read.mockImplementation(async () => queue);
  mocks.prepareWriting.mockRejectedValueOnce(new Error("lost response"));
  const render = (conversationId: string) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={conversationId} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash"
    readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
    files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
    messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />);
  try {
    await act(async () => render(id));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Question");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(container.querySelector('[data-pending-submission="true"]')?.textContent).toContain("Question");
    expect(textarea.value).toBe("Question");
    expect(textarea.disabled).toBe(true);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(mocks.prepareWriting).toHaveBeenCalledOnce();
    const nextId = "22222222-2222-4222-8222-222222222222";
    queue = {...queue, conversationId: nextId}; await act(async () => render(nextId));
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    queue = {...queue, conversationId: id}; await act(async () => render(id));
    expect(container.querySelector('[data-pending-submission="true"]')?.textContent).toContain("Question");
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    expect(mocks.prepareWriting).toHaveBeenCalledOnce();
  } finally {await act(async () => root.unmount()); container.remove();}
});

it("keeps a previous conversation's late completion from changing the new conversation's pending send", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const nextId = "22222222-2222-4222-8222-222222222222";
  let queue: AgentWritingQueueResponse = {schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false, preparingInputId: null, inputs: []};
  mocks.read.mockImplementation(async () => queue);
  const resolvers: ((buffers: AgentWorkspaceBuffer[]) => void)[] = [];
  const readFileBuffers = () => new Promise<AgentWorkspaceBuffer[]>(resolve => {resolvers.push(resolve);});
  const props = {manuscriptId: id, conversationTitle: "Paper", activePath: "main.tex", content: "source", contentHash: "hash",
    files: [{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex" as const, sha256: "hash", sizeBytes: 6, modifiedAt: "now"}],
    messages: [] as WritingAgentMessage[], projection: null, historyReady: true, open: true, onOpenChange: () => undefined,
    readEditorSnapshot: () => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"}), readFileBuffers};
  const send = async (text: string) => {
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  };
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel {...props} conversationId={id} />));
    await send("First"); expect(resolvers).toHaveLength(1);
    queue = {...queue, conversationId: nextId};
    await act(async () => root.render(<WritingAgentRuntimePanel {...props} conversationId={nextId} />));
    expect(container.querySelector('[data-pending-submission="true"]')).toBeNull();
    await send("Second"); expect(resolvers).toHaveLength(2);
    await act(async () => resolvers[0]!([{path: "main.tex", expectedDiskSha256: "hash", sessionId: id, revision: id, text: "source"}]));
    expect(container.querySelector('[data-pending-submission="true"]')?.textContent).toContain("Second");
    expect(container.querySelector("textarea")!.disabled).toBe(true);
  } finally {await act(async () => root.unmount()); container.remove();}
});

it("automatically prepares and starts a queued message while idle", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let queue: AgentWritingQueueResponse = { schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0, paused: false,
    preparingInputId: null as string | null, inputs: [] as { inputId: string; text: string }[] };
  mocks.read.mockImplementation(async () => queue);
  mocks.edit.mockImplementation(async (request) => { queue = { ...queue, revision: queue.revision + 1,
    inputs: [...queue.inputs, { inputId: request.edit.inputId, text: request.edit.text }] }; return queue; });
  mocks.prepare.mockImplementation(async (request) => {
    queue = { ...queue, revision: queue.revision + 1, preparingInputId: request.inputId };
    const result = { schemaVersion: 1, inputId: request.inputId, queue, preview: { schemaVersion: 1,
      conversationId: id, manuscriptId: id, requestId: request.submission.requestId, turnId: id, contextSnapshotId: id,
      input: { text: request.submission.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: [] } } };
    mocks.recover.mockImplementation(async () => queue.preparingInputId === request.inputId ? {...result, queue} : null);
    return result;
  });
  mocks.start.mockImplementation(async (request) => { queue = { ...queue, revision: queue.revision + 1, inputs: [], preparingInputId: null };
    return { schemaVersion: 1, conversationId: id, requestId: request.start.requestId, turnId: id, alreadyStarted: false, outcome: null }; });
  const storage = getAppStorage();
  const queueStartKey = `research-assistant:writing-queue-start:v1:${id}:${id}`;
  let releaseStartCleanup!: () => void, waitingForCleanup = false;
  const startCleanup = new Promise<void>(resolve => {releaseStartCleanup = resolve;});
  registerStoragePersistence(storage, {backend: "IndexedDB", pending: false, error: undefined, resetting: false,
    flush: async () => {const stored = storage.getItem(queueStartKey); if (stored && JSON.parse(stored).result) {waitingForCleanup = true; await startCleanup;}},
    retry: async () => {}, reset: async () => {}, subscribe: () => () => {}, close: () => {}});
  let finishWorkspace!: () => void;
  workspace.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { finishWorkspace = resolve; }));
  const render = (running: boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="Unsaved" contentHash="hash"
      readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "Unsaved" })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 3, modifiedAt: "now" }]}
      messages={[]} projection={running ? runningProjection : null} historyReady open onOpenChange={() => undefined} />);
  try {
    await act(async () => render(true));
    const textarea = container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Next message");
      textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(mocks.edit).toHaveBeenCalledOnce(); expect(textarea.value).toBe("");
    await act(async () => render(false));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.prepare.mock.calls[0]?.[0].submission.context.files[0].buffer.text).toBe("Unsaved");
    expect(workspace.prepare).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(container.querySelector("form.writing-agent-composer [role=status]")?.textContent).toContain("发送中"));
    expect(container.querySelector(".writing-agent-input-queue")?.textContent).not.toContain("消息发送状态待确认");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
    await act(async () => finishWorkspace());
    expect(mocks.start).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(waitingForCleanup).toBe(true));
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
    expect(container.querySelector(".agent-composer-input-state")?.classList.contains("is-preparing")).toBe(true);
    await act(async () => releaseStartCleanup());
    await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(false));
    expect(workspace.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]!);
    expect(queue.inputs).toHaveLength(0);
    expect(container.textContent).not.toContain("立即发送队首");
    expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally { releaseStartCleanup(); await act(async () => root.unmount()); container.remove(); }
});

it("offers original queue request review when stopping preparation cannot confirm its receipt", async () => {
  vi.clearAllMocks();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  let queue: AgentWritingQueueResponse = {schemaVersion:1,conversationId:id,manuscriptId:id,revision:0,paused:false,preparingInputId:null,inputs:[]};
  mocks.read.mockImplementation(async () => queue);
  mocks.edit.mockImplementation(async request => {queue={...queue,revision:queue.revision+1,
    inputs:[...queue.inputs,{inputId:request.edit.inputId,text:request.edit.text}]};return queue;});
  let rejectPrepare!: (reason: Error) => void;
  mocks.prepare.mockImplementation(() => new Promise((_,reject) => {rejectPrepare=reject;}));
  mocks.prepareStatus.mockImplementation(async intent => ({schemaVersion:1,intent,status:{type:"notFound"}}));
  const render=(running:boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash"
    readEditorSnapshot={() => ({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})}
    files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
    messages={[]} projection={running ? runningProjection : null} historyReady open onOpenChange={() => undefined}/>);
  try {
    await act(async () => render(true));
    const textarea=container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"Queued question");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
    await act(async () => render(false));
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="停止发送"]')!.click());
    await act(async () => rejectPrepare(new Error("lost response")));
    await vi.waitFor(() => expect(container.textContent).toContain("无法确认发送已停止"));
    expect(container.textContent).not.toContain("正在停止发送");
    expect(container.textContent).toContain("；R=");
    expect(queue.inputs).toHaveLength(1);
    const callsBefore=mocks.prepareStatus.mock.calls.length;
    await act(async () => buttonByText("重新读取")!.click());
    await vi.waitFor(() => expect(mocks.prepareStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(queue.inputs).toHaveLength(1);
  } finally {await act(async () => root.unmount());container.remove();}
});

it("stops a queued send during file capture and durably pauses only the original item", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let queue: AgentWritingQueueResponse = {schemaVersion: 1, conversationId: id, manuscriptId: id, revision: 0,
    paused: false, preparingInputId: null, inputs: []};
  mocks.read.mockImplementation(async () => queue);
  mocks.edit.mockImplementation(async request => {
    if (request.edit.type === "add") queue = {...queue, revision: queue.revision + 1,
      inputs: [...queue.inputs, {inputId:request.edit.inputId,text:request.edit.text}]};
    if (request.edit.type === "pauseInput") queue = {...queue, revision: queue.revision + 1,
      inputs: queue.inputs.map(input => input.inputId === request.edit.inputId ? {...input, paused:true} : input)};
    return queue;
  });
  let finishBuffers!: (buffers: AgentWorkspaceBuffer[]) => void;
  const buffers = new Promise<AgentWorkspaceBuffer[]>(resolve => {finishBuffers = resolve;});
  const readFileBuffers = vi.fn(() => buffers);
  const render = (running: boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash" readFileBuffers={readFileBuffers}
    readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId:id, revision:id, text:"source"})}
    files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
    messages={[]} projection={running ? runningProjection : null} historyReady open onOpenChange={() => undefined}/>);
  try {
    await act(async () => render(true));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"Queued");
      textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
    expect(queue.inputs).toHaveLength(1);
    const inputId=queue.inputs[0]!.inputId;
    await act(async () => render(false));
    await vi.waitFor(() => expect(readFileBuffers).toHaveBeenCalledOnce());
    const stop=container.querySelector<HTMLButtonElement>('button[aria-label="停止发送"]')!;
    expect(stop).not.toBeNull();
    await act(async () => stop.click());
    await vi.waitFor(() => expect(queue.inputs[0]).toMatchObject({inputId,paused:true}));
    await act(async () => finishBuffers([{path:"main.tex",expectedDiskSha256:"hash",sessionId:id,revision:id,text:"source"}]));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(queue.inputs).toHaveLength(1);
  } finally {finishBuffers([]); await act(async () => root.unmount()); container.remove();}
});

it("retains an unresolved queue stop across reopening and retries the same item before dispatch", async () => {
  vi.clearAllMocks();
  const container = document.createElement("div"); document.body.append(container); let root = createRoot(container);
  let queue: AgentWritingQueueResponse = {schemaVersion:1,conversationId:id,manuscriptId:id,revision:0,paused:false,preparingInputId:null,inputs:[]};
  let failPause = true;
  mocks.read.mockImplementation(async () => queue);
  mocks.edit.mockImplementation(async request => {
    if (request.edit.type === "add") queue = {...queue,revision:queue.revision+1,inputs:[...queue.inputs,{inputId:request.edit.inputId,text:request.edit.text}]};
    if (request.edit.type === "pauseInput") {
      if (failPause) throw {code:"invalid"};
      const inputId = request.edit.inputId;
      queue = {...queue,revision:queue.revision+1,inputs:queue.inputs.map(input => input.inputId===inputId ? {...input,paused:true} : input)};
    }
    return queue;
  });
  let finishBuffers!: (buffers:AgentWorkspaceBuffer[]) => void;
  const buffers = new Promise<AgentWorkspaceBuffer[]>(resolve => {finishBuffers=resolve;});
  const readFileBuffers = vi.fn(() => buffers);
  const render = (running:boolean) => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
    activePath="main.tex" content="source" contentHash="hash" readFileBuffers={readFileBuffers}
    readEditorSnapshot={() => ({documentKey:`${id}:main.tex`,sessionId:id,revision:id,text:"source"})}
    files={[{manuscriptId:id,relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"hash",sizeBytes:6,modifiedAt:"now"}]}
    messages={[]} projection={running ? runningProjection : null} historyReady open onOpenChange={() => undefined}/>);
  try {
    await act(async () => render(true));
    const textarea=container.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"Queued");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
    const inputId=queue.inputs[0]!.inputId;
    await act(async () => render(false));
    await vi.waitFor(() => expect(readFileBuffers).toHaveBeenCalledOnce());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="停止发送"]')!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("无法确认发送已停止"));
    const holdKey=`research-assistant:writing-queue-stop:v1:${id}:${id}`;
    expect(JSON.parse(getAppStorage().getItem(holdKey)!).inputId).toBe(inputId);
    expect(queue.inputs[0]?.paused).not.toBe(true);
    await act(async () => root.unmount());
    resetWritingSubmissionControllersForTests();
    root=createRoot(container);
    await act(async () => render(false));
    await vi.waitFor(() => expect(container.textContent).toContain("无法确认发送已停止"));
    expect(readFileBuffers).toHaveBeenCalledOnce();
    failPause=false;
    await act(async () => [...container.querySelectorAll("button")].find(button=>button.textContent==="重新读取")!.click());
    await vi.waitFor(() => expect(queue.inputs[0]?.paused).toBe(true));
    await vi.waitFor(() => expect(getAppStorage().getItem(holdKey)).toBeNull());
    await act(async () => finishBuffers([{path:"main.tex",expectedDiskSha256:"hash",sessionId:id,revision:id,text:"source"}]));
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    expect(readFileBuffers).toHaveBeenCalledOnce();
  } finally {finishBuffers([]); await act(async () => root.unmount()); container.remove();}
});

it("queues a normal second send while the active turn is running", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let queue: AgentWritingQueueResponse = { schemaVersion: 1, conversationId: id, manuscriptId: id,
    revision: 0, paused: false, preparingInputId: null, inputs: [] };
  mocks.read.mockImplementation(async () => queue);
  mocks.edit.mockImplementation(async (request) => {
    queue = { ...queue, revision: queue.revision + 1,
      inputs: [...queue.inputs, { inputId: request.edit.inputId, text: request.edit.text }] };
    return queue;
  });
  mocks.prepareWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id,
    manuscriptId: id, requestId: request.requestId, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null },
      reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id,
    requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("First question");
    mocks.read.mockClear();
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.startWriting).toHaveBeenCalledOnce();
    expect(mocks.read.mock.calls.length).toBeLessThanOrEqual(2);
    await type("Second question");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(mocks.steer).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledOnce();
    expect(queue.inputs).toHaveLength(1);
    expect(mocks.startWriting).toHaveBeenCalledOnce();
    expect(container.querySelector(".writing-agent-input-queue")?.textContent ?? "").toContain("Second question");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("resumes a system-paused queue after a new ordinary message starts", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let queue: AgentWritingQueueResponse = { schemaVersion: 1, conversationId: id, manuscriptId: id,
    revision: 4, paused: true, preparingInputId: null, inputs: [{ inputId: "queued", text: "Later" }] };
  mocks.read.mockImplementation(async () => queue);
  mocks.edit.mockImplementation(async (request) => {
    if (request.edit.type === "resume") queue = { ...queue, revision: queue.revision + 1, paused: false };
    return queue;
  });
  mocks.prepareWriting.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: id,
    manuscriptId: id, requestId: request.requestId, turnId: id, contextSnapshotId: id,
    input: { text: request.text, model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null, context: submissionContext(request) } }));
  mocks.startWriting.mockImplementation(async request => ({ schemaVersion: 1, conversationId: id, requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null }));
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Continue work");
    await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.edit).toHaveBeenCalledWith(expect.objectContaining({ edit: { type: "resume" } }));
    expect(queue.paused).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("opens a saved pending preview without re-reading editor content or automatically sending", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const queue = { schemaVersion: 1 as const, conversationId: id, manuscriptId: id, revision: 5, paused: false,
    preparingInputId: id, inputs: [{ inputId: id, text: "Saved question" }] };
  mocks.read.mockResolvedValue(queue);
  mocks.recover.mockResolvedValue({ schemaVersion: 1, inputId: id, queue, preview: {
    schemaVersion: 1, conversationId: id, manuscriptId: id, requestId: id, turnId: id, contextSnapshotId: id,
    input: { text: "Saved question", model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null }, reasoningEffort: null,
      context: [{ sourceId: "frozen", kind: "manuscript", resourceId: "main.tex", revision: "old", anchor: null, text: "Original frozen source" }] } } });
  mocks.cancel.mockResolvedValue({ ...queue, revision: 6, preparingInputId: null, paused: true });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="Changed editor text" contentHash="new" files={[]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    const composer = container.querySelector<HTMLFormElement>("form.writing-agent-composer")!;
    const recovery = composer.querySelector<HTMLButtonElement>(".agent-composer-state-action")!;
    expect(composer.querySelector('[role="status"]')?.textContent).toContain("消息发送状态待确认");
    expect(recovery.textContent).toBe("处理消息");
    expect(recovery.disabled).toBe(false);
    expect(container.querySelector(".writing-agent-input-queue")?.textContent).not.toContain("消息发送状态待确认");
    await act(async () => recovery.click());
    expect(container.querySelector('[aria-label="写作提交状态"]')).toBeNull();
    expect(container.querySelector('[aria-label="发送恢复"]')).toBeNull();
    expect(notify.error).toHaveBeenCalledWith("有尚未发送的队列消息，请重新发送。",expect.objectContaining({actions:expect.arrayContaining([
      expect.objectContaining({id: "primary", label: "重新发送"}), expect.objectContaining({id: "secondary", label: "返回编辑"}),
    ])}));
    expect(container.textContent).not.toContain("Changed editor text");
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    const cancel=vi.mocked(notify.error).mock.lastCall?.[1]?.actions?.find(action => action.id === "secondary");
    if(cancel && typeof cancel==="object" && "onClick" in cancel && typeof cancel.onClick==="function")
      await act(async()=>{(cancel.onClick as ()=>void)();});
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ inputId: id, expectedRevision: 5, previewRequestId: id }));
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not expose legacy unstarted-admission actions in the writing runtime", async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.list.mockResolvedValue({ schemaVersion: 1, conversationId: id, manuscriptId: id, nextCursor: null,
    items: [{ inputId: id, expectedRevision: 12, preview: { schemaVersion: 1, conversationId: id, manuscriptId: id,
      requestId: id, turnId: id, contextSnapshotId: id, input: { text: "Admitted text", context: [], reasoningEffort: null,
        model: { providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null } } } }] });
  mocks.start.mockResolvedValue({ schemaVersion: 1, conversationId: id, requestId: id, turnId: id, alreadyStarted: false, outcome: null });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="New editor text" contentHash="new" files={[]} messages={[]} projection={null} historyReady open onOpenChange={() => undefined} />));
    expect(container.textContent).not.toContain("检查未启动的提交");
    expect(container.querySelector('summary[aria-label="更多会话操作"]')).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each([false,true])("retains an actual queued Enter request across module unmount and protects retyped draft=%s", async retyped => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const initial: AgentWritingQueueResponse = { schemaVersion: 1, conversationId: id, manuscriptId: id,
    revision: 0, paused: false, preparingInputId: null, inputs: [] };
  mocks.read.mockResolvedValue(initial);
  let reject!: (error: unknown) => void;
  mocks.edit.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockRejectedValueOnce(new Error("still offline")).mockRejectedValueOnce(new Error("still offline"))
    .mockResolvedValue({ ...initial, revision: 1 });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = async (present: boolean, ready = true) => { await act(async () => root.render(<AgentQueueProvider><AgentDraftProvider>
    {present && <WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash"
      readEditorSnapshot={() => ({ documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source" })}
      files={[{ manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now" }]}
      messages={[]} projection={runningProjection} historyReady={ready} open onOpenChange={() => undefined} />}
  </AgentDraftProvider></AgentQueueProvider>)); };
  const text = () => container.querySelector("textarea")!;
  const type = async (value: string) => { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(text(),value);
    text().dispatchEvent(new Event("input",{bubbles:true}));
  }); };
  try {
    await render(true); await type("Original queue message");
    await act(async () => text().dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
    expect(mocks.edit).toHaveBeenCalledOnce();
    await render(false); await act(async () => reject(new Error("lost reply")));
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    const reads = mocks.read.mock.calls.length;
    await render(true, false);
    expect(mocks.read.mock.calls.length).toBe(reads);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="重试队列同步"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-action="send"]')?.disabled).toBe(true);
    await render(true);
    expect(container.textContent).toContain("队列暂时无法同步"); expect(text().value).toBe("Original queue message");
    if(retyped){await type("Changed"); await type("Original queue message");}
    await act(async () => text().dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(mocks.edit).toHaveBeenCalledTimes(3); expect(mocks.prepareWriting).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="重试队列同步"]')!.click());
    expect(mocks.edit.mock.calls[0]).toEqual(mocks.edit.mock.calls[3]);
    expect(text().value).toBe(retyped ? "Original queue message" : "");
    expect(container.textContent).not.toContain("操作结果未确认");
    expect(mocks.startWriting).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); }
});

it.each([false, true])("keeps an admitted steer outside history until formal confirmation (wait for metadata: %s)", async (waitForMetadata) => {
  vi.clearAllMocks();
  mocks.steer.mockImplementation(async (request) => ({ schemaVersion: 1, conversationId: request.conversationId, turnId: request.turnId, inputId: request.inputId }));
  const projection: AgentConversationProjection = { conversationId: id, seq: 1, activeTurn: "turn", turnOrder: ["turn"], turns: new Map([["turn", {
    contextSnapshotId: "context", model: { providerId: "test", modelId: "test", revision: null }, phase: "runningModel", outcome: null,
    itemOrder: [], items: new Map(), attemptOrder: [], attempts: new Map(), inputTokens: null, outputTokens: null,
  }]]) };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let metadataLoading = waitForMetadata;
  const render = (messages: readonly WritingAgentMessage[]) => root.render(<AgentSteeringProvider><AgentDraftProvider>
    <WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper" activePath="main.tex"
      content="source" contentHash="hash" files={[]} messages={messages} projection={projection} historyReady open
      metadataLoading={metadataLoading} metadataUnavailable={metadataLoading ? "正在核对对话状态…" : undefined} onOpenChange={() => undefined} />
  </AgentDraftProvider></AgentSteeringProvider>);
  try {
    await act(async () => render([]));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Steer immediately");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    if (waitForMetadata) {
      expect(mocks.steer).not.toHaveBeenCalled();
      expect(container.querySelector('.agent-composer-input-state [aria-label="输入框准备状态"]')).not.toBeNull();
      metadataLoading = false;
      await act(async () => render([]));
      expect(mocks.prepareWriting).not.toHaveBeenCalled();
    }
    expect(mocks.steer).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-pending-steering]')?.textContent).toContain("Steer immediately");
    expect(container.querySelectorAll(".writing-agent-message.user")).toHaveLength(1);
    const request = mocks.steer.mock.calls[0]?.[0] as { inputId: string; turnId: string };
    const update = { id: `${request.turnId}/assistant`, turnId: request.turnId, role: "assistant" as const, content: "工具继续输出", turnFinished: false };
    await act(async () => render([update]));
    const pendingBubble = container.querySelector('[data-pending-steering]')!;
    expect(container.querySelector(`[data-agent-message-id="${update.id}"]`)!.compareDocumentPosition(pendingBubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const durable = { id: `${request.turnId}/${request.inputId}`, conversationId:id, turnId: request.turnId, role: "user" as const, content: "Steer immediately", streaming:false };
    await act(async () => render([update,durable]));
    expect(container.querySelectorAll(`[data-agent-message-id="${durable.id}"]`)).toHaveLength(1);
    expect(container.querySelector('[data-pending-steering]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
