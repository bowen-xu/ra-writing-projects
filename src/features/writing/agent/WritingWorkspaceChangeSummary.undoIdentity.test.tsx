/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import type {AgentWorkspaceScope} from "@research-assistant/core/agent";
import {AgentTurnChangeSummary} from "../../../../../../apps/web/src/core/features/agent/AgentTurnChangeSummary";
import {WritingWorkspaceChangeSummary} from "./WritingWorkspaceReview";
import {WritingFileSessions} from "../editor/writingFileSessions";
import type {EditorApplicationResult} from "../editor/editorApplication";
import type {UndoWritingProposal} from "./writingCardUndo";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const io = vi.hoisted(() => ({latest: vi.fn(), readFile: vi.fn(), review: vi.fn(), error: vi.fn()}));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", () => ({agentProposalGateway: io, agentWorkspaceReviewGateway: io}));
vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({notify: {error: io.error}}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0)) await cleanup(); vi.resetAllMocks();});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
async function settled(assertion: () => void) {await vi.waitFor(async () => {await act(async () => Promise.resolve()); assertion();});}
function fixture() {
  const scope: AgentWorkspaceScope = {manuscriptId: crypto.randomUUID(), conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID()};
  const files = new WritingFileSessions(), file = files.open({manuscriptId: scope.manuscriptId, relativePath: "main.tex"}, "Old", "a".repeat(64));
  const apply = (text: string, request = scope) => {const operationId = crypto.randomUUID();
    expect(file.applyAgent(operationId, file.read().version, text, {operationId, conversationId: request.conversationId, requestId: request.requestId, resultSha256: "b".repeat(64)})).toBe("applied");};
  apply("New");
  const proposal = (request = scope, proposalId = crypto.randomUUID()) => ({schemaVersion: 1, proposalId, status: "accepted", review: {
    schemaVersion: 1, binding: {scope: request, turnId: crypto.randomUUID(), leaseId: crypto.randomUUID(), manifestHash: "a".repeat(64)},
    changes: [{path: "main.tex", kind: "modified", hasEditorBuffer: true, before: {sha256: "a".repeat(64), byteSize: 3, executable: false}, after: {sha256: "b".repeat(64), byteSize: 3, executable: false}}],
  }});
  const original = proposal(); io.latest.mockResolvedValue(original);
  io.readFile.mockResolvedValue({file: {before: {kind: "text", text: "Old"}, after: {kind: "text", text: "New"}}});
  return {scope, files, file, apply, proposal, original};
}
function applied(f: ReturnType<typeof fixture>): EditorApplicationResult {
  return {kind: "state", state: {kind: "state", schemaVersion: 1, status: "applied", files: [], scope: {
    manuscriptId: f.scope.manuscriptId, conversationId: f.scope.conversationId, proposalId: f.original.proposalId, operationId: crypto.randomUUID(),
  }}};
}
async function mount(f: ReturnType<typeof fixture>, undo: UndoWritingProposal, report?: (error: {message:string;retry:()=>void} | null)=>void) {
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  cleanups.push(async () => {await act(async () => root.unmount()); host.remove();});
  const render = async (scope = f.scope) => act(async () => root.render(<AgentTurnChangeSummary>
    <WritingWorkspaceChangeSummary scope={scope} disabled={false} fileSessions={f.files} undoProposal={undo} onReadErrorChange={report}/>
  </AgentTurnChangeSummary>));
  await render(); const button = () => host.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-undo")!;
  await settled(() => expect(button()?.disabled).toBe(false));
  return {host, render, button};
}

it("retains the original successful Undo across a real ops1→2 proposal refresh and contribution remount", async () => {
  const f = fixture(), acknowledgement = deferred<EditorApplicationResult>(), reload = deferred<ReturnType<typeof f.proposal>>();
  const undo = vi.fn<UndoWritingProposal>(() => acknowledgement.promise), h = await mount(f, undo);
  await act(async () => {expect(f.file.resolveAll("keep")).toBe(true); h.button().click();});
  expect(undo).toHaveBeenCalledTimes(1); expect(f.file.readOperations()).toHaveLength(1);
  io.latest.mockImplementationOnce(() => reload.promise);
  await act(async () => f.apply("Old"));
  await settled(() => expect(h.button()?.disabled).toBe(true));
  expect(h.host.textContent).not.toContain("正在读取文件变更");
  expect(f.file.readOperations()).toHaveLength(2);
  await act(async () => acknowledgement.resolve(applied(f)));
  await act(async () => reload.resolve(f.original));
  await settled(() => expect(h.button()).not.toBeNull());
  expect(h.host.textContent).not.toContain("部分修改已撤销"); expect(h.button().disabled).toBe(true);
  // Matching text later does not authorize a second dispatch of the confirmed original Undo.
  await act(async () => f.apply("New", {...f.scope, requestId: crypto.randomUUID()}));
  expect(h.button().disabled).toBe(true); await act(async () => h.button().click());
  expect(undo).toHaveBeenCalledTimes(1); expect(io.error).not.toHaveBeenCalled();
});

it("keeps a confirmed summary visible and undo protected after a failed refresh until retry succeeds", async () => {
  const f = fixture(), undo = vi.fn<UndoWritingProposal>().mockResolvedValue(applied(f)), report = vi.fn(), h = await mount(f, undo, report);
  io.latest.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => f.apply("Old"));
  await settled(() => expect(report.mock.calls.at(-1)?.[0]).toBeTruthy());
  expect(h.host.textContent).toContain("main.tex");
  expect(h.host.textContent).not.toContain("正在读取文件变更");
  expect(h.button().disabled).toBe(true);
  const failure = report.mock.calls.at(-1)?.[0] as {message:string;retry:()=>void};
  await act(async () => failure.retry());
  await settled(() => expect(io.latest).toHaveBeenCalledTimes(3));
  expect(report).toHaveBeenLastCalledWith(null);
  expect(h.host.textContent).toContain("main.tex");
});

it.each(["request", "proposal"] as const)("does not inherit a completed Undo for a new %s at the same file path", async changed => {
  const f = fixture(), undo = vi.fn<UndoWritingProposal>().mockResolvedValue(applied(f)), h = await mount(f, undo);
  await act(async () => h.button().click()); expect(h.button().disabled).toBe(true);
  const nextScope = changed === "request" ? {...f.scope, requestId: crypto.randomUUID()} : f.scope;
  const next = f.proposal(nextScope); io.latest.mockResolvedValue(next);
  undo.mockResolvedValue(applied({...f, scope: nextScope, original: next}));
  if (changed === "request") await h.render(nextScope);
  else {await act(async () => {f.apply("Old"); f.apply("New");});}
  await settled(() => expect(h.button()?.disabled).toBe(false));
  expect(h.host.textContent).not.toContain("部分修改已撤销");
  await act(async () => h.button().click());
  expect(undo).toHaveBeenCalledTimes(2); expect(undo).toHaveBeenLastCalledWith({manuscriptId: nextScope.manuscriptId, conversationId: nextScope.conversationId, proposalId: next.proposalId});
});
