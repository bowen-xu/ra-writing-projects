/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from "vitest";
import { undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { AgentApplicationRequest, AgentApplicationState } from "@research-assistant/core/agent";
import { createWritingEditorApplication } from "./editorApplication";
import { WritingFileSessions } from "./writingFileSessions";

const views: EditorView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); });

function fixture() {
  const scope = { manuscriptId: "manuscript", conversationId: "conversation", proposalId: "proposal", operationId: "operation" };
  const files = new WritingFileSessions();
  const first = files.open({ manuscriptId: scope.manuscriptId, relativePath: "main.tex" }, "old main", "a".repeat(64));
  const second = files.open({ manuscriptId: scope.manuscriptId, relativePath: "second.tex" }, "old second", "b".repeat(64));
  const originals = files.readBuffers(scope.manuscriptId);
  let state: AgentApplicationState = { kind: "state", schemaVersion: 1, scope, status: "applying", files: originals.map((buffer) => ({
    path: buffer.path, phase: "pending", target: { kind: "editor", sessionId: buffer.sessionId, revision: buffer.revision, resultRevision: null },
  })) };
  let beforeReply: (() => void) | undefined;
  const execute = vi.fn(async (request: AgentApplicationRequest) => {
    if (request.action === "prepareEditor") {
      state = { ...state, files: state.files.map((file) => file.path === request.current.path ? { ...file, phase: "dispatched" } : file) };
      beforeReply?.();
      return { kind: "edit" as const, schemaVersion: 1 as const, scope, expected: request.current, text: request.current.text.replace("old", "new") };
    }
    if (request.action === "confirmEditor") {
      state = { ...state, files: state.files.map((file) => file.path === request.actual.path && file.target.kind === "editor"
        ? { ...file, phase: "acknowledged", target: { ...file.target, resultRevision: request.actual.revision } } : file) };
      if (state.files.every((file) => file.phase === "acknowledged")) state = { ...state, status: "applied" };
    }
    if (request.action === "deferEditor") state = { ...state, status: "recoveryRequired" };
    return state;
  });
  const application = createWritingEditorApplication({ execute }, (value, path) => files.get({ manuscriptId: value.manuscriptId, relativePath: path })?.applicationPort ?? null);
  return { first, second, scope, application, execute, beforeReply: (callback: () => void) => { beforeReply = callback; } };
}

it("applies multiple native editor targets to their own file state without requiring another EditorView", async () => {
  const host = fixture();
  expect((await host.application.apply(host.scope, "main.tex")).kind).toBe("state");
  const result = await host.application.apply(host.scope, "second.tex");
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(host.first.read()).toMatchObject({ content: "new main", reviewBaseline: "old main" });
  expect(host.second.read()).toMatchObject({ content: "new second", reviewBaseline: "old second" });
  expect(undo({ state: host.second.state, dispatch: (transaction) => host.second.accept([transaction]) })).toBe(true);
  expect(host.second.read()).toMatchObject({ content: "old second", reviewBaseline: "old second" });
  expect(host.first.read().content).toBe("new main");
  expect(redo({ state: host.second.state, dispatch: (transaction) => host.second.accept([transaction]) })).toBe(true);
  expect(host.second.pending).toBe(true);
});

it("reconciles a headless file's historical receipt after Keep and later editing without replaying it", async () => {
  const host = fixture();
  await host.application.apply(host.scope, "second.tex");
  const port = host.second.applicationPort, receipt = port.readReceipt(host.scope.operationId);
  host.second.resolveAll("keep");
  host.second.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" });
  const current = host.second.read(), apply = vi.spyOn(port, "apply");
  await host.application.recover(host.scope, "second.tex");
  expect(apply).not.toHaveBeenCalled();
  expect(host.second.applicationPort).toBe(port);
  expect(port.readReceipt(host.scope.operationId)).toEqual(receipt);
  expect(host.second.read()).toEqual(current);
});

it("rejects late native commands when the target file changed during preparation", async () => {
  const host = fixture();
  host.beforeReply(() => host.second.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" }));
  expect((await host.application.apply(host.scope, "second.tex")).kind).toBe("unconfirmed");
  expect(host.second.read().content).toBe("manual old second");
  expect(host.first.read().content).toBe("old main");
  expect(host.execute.mock.calls.some(([request]) => request.action === "confirmEditor")).toBe(false);
});

it("keeps the same file port and receipt across attaching, switching and reopening the visible editor", async () => {
  const host = fixture(), port = host.first.applicationPort;
  const view = new EditorView({ state: host.first.state, dispatchTransactions: (transactions) => host.first.accept(transactions) });
  views.push(view); host.first.attach(view);
  await host.application.apply(host.scope, "main.tex");
  const receipt = port.readReceipt(host.scope.operationId);
  expect(view.state.doc.toString()).toBe("new main");
  host.first.detach(view);
  view.setState(host.second.state); host.second.attach(view);
  await host.application.apply(host.scope, "main.tex");
  expect(host.first.applicationPort).toBe(port);
  expect(port.readReceipt(host.scope.operationId)).toEqual(receipt);
  expect(view.state.doc.toString()).toBe("old second");
  host.second.detach(view);
  view.setState(host.first.state); host.first.attach(view);
  expect(view.state.doc.toString()).toBe("new main");
  expect(undo(view)).toBe(true);
  expect(host.first.read().content).toBe("old main");
  expect(port.readReceipt(host.scope.operationId)).toEqual(receipt);
  host.first.detach(view);
});
