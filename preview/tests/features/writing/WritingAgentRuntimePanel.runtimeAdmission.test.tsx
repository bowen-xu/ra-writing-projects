/** @vitest-environment happy-dom */
import {mocks, workspace, id, submissionContext, WritingAgentRuntimePanel} from "./WritingAgentRuntimePanel.test-harness.tsx";
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {AgentWorkspaceBuffer} from "@research-assistant/core/agent";
import {parseManuscriptPath} from "@research-assistant/writing";
import {WritingRuntimeAdmissionScope} from "@research-assistant/writing-projects-preview/writing-runtime-admission";

let root: Root, host: HTMLDivElement, disabled: boolean;
let listeners: Set<() => void>;
const admitted = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); disabled = false; listeners = new Set();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mocks.prepareWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id,
    requestId: request.requestId, manuscriptId: id, turnId: id, contextSnapshotId: id,
    input: {text: request.text, model: {providerId: "deepseek", modelId: "deepseek-v4-pro", revision: null}, reasoningEffort: null,
      context: submissionContext(request)}}));
  mocks.startWriting.mockImplementation(async request => ({schemaVersion: 1, conversationId: id,
    requestId: request.requestId, turnId: id, alreadyStarted: false, outcome: null}));
});
afterEach(async () => {await act(async () => root.unmount()); host.remove();});
const admission = {isDisabled: () => disabled, subscribe: (listener: () => void) => {
  listeners.add(listener); return () => {listeners.delete(listener);};
}};
async function disable(publish = true) {
  await act(async () => {disabled = true; if (publish) for (const listener of listeners) listener();});
}
async function mount(readFileBuffers?: () => Promise<readonly AgentWorkspaceBuffer[]>) {
  await act(async () => root.render(<WritingRuntimeAdmissionScope value={admission}>
    <WritingAgentRuntimePanel manuscriptId={id} conversationId={id} conversationTitle="Paper"
      activePath="main.tex" content="source" contentHash="hash" onSubmissionAdmitted={admitted}
      readEditorSnapshot={() => ({documentKey: `${id}:main.tex`, sessionId: id, revision: id, text: "source"})}
      {...(readFileBuffers ? {readFileBuffers} : {})}
      files={[{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "hash", sizeBytes: 6, modifiedAt: "now"}]}
      messages={[]} projection={null} historyReady open onOpenChange={() => undefined}/>
  </WritingRuntimeAdmissionScope>));
}
async function draft() {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Keep this draft");
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
}
async function send() {
  await act(async () => {host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));});
}

it("rejects a new send using the live instance even before its React notification", async () => {
  await mount(); await draft(); await disable(false); await send();
  expect(mocks.prepareWriting).not.toHaveBeenCalled();
  expect(mocks.startWriting).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
});

it("does not prepare after file capture returns to a disabled instance", async () => {
  let finish!: (buffers: readonly AgentWorkspaceBuffer[]) => void;
  const read = vi.fn(() => new Promise<readonly AgentWorkspaceBuffer[]>(resolve => {finish = resolve;}));
  await mount(read); await draft(); await send();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await disable(); await act(async () => finish([]));
  expect(mocks.prepareWriting).not.toHaveBeenCalled();
  expect(mocks.startWriting).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
});

it("retains an original preparation reply without starting another step while disabled", async () => {
  const original = mocks.prepareWriting.getMockImplementation()!;
  let finish!: () => void;
  mocks.prepareWriting.mockImplementationOnce(async request => {
    await new Promise<void>(resolve => {finish = resolve;});
    return original(request);
  });
  await mount(); await draft(); await send();
  await vi.waitFor(() => expect(mocks.prepareWriting).toHaveBeenCalledOnce());
  const request = mocks.prepareWriting.mock.calls[0]![0];
  await disable(); await act(async () => finish());
  expect(workspace.prepare).not.toHaveBeenCalled();
  expect(mocks.startWriting).not.toHaveBeenCalled();
  expect(mocks.prepareWriting.mock.calls[0]![0]).toBe(request);
  expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
});

it("settles an admitted start reply after disable without replaying prepare or start", async () => {
  const original = mocks.startWriting.getMockImplementation()!;
  let finish!: () => void;
  mocks.startWriting.mockImplementationOnce(async request => {
    await new Promise<void>(resolve => {finish = resolve;});
    return original(request);
  });
  await mount(); await draft(); await send();
  await vi.waitFor(() => expect(mocks.startWriting).toHaveBeenCalledOnce());
  const request = mocks.startWriting.mock.calls[0]![0];
  await disable(); await act(async () => finish());
  await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce());
  expect(mocks.prepareWriting).toHaveBeenCalledOnce();
  expect(mocks.startWriting).toHaveBeenCalledExactlyOnceWith(request);
  expect(host.querySelector("textarea")?.value).toBe("");
});
