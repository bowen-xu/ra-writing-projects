/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { AgentEditorSessionPort, AgentUndoRequest } from "@research-assistant/core/agent";
import { createAgentUndoGateway } from "@research-assistant/data/agent";
import { writingEditorIdentity } from "./editorSession";
import { createWritingEditorSessionPort } from "./editorSessionPort";
import { createWritingEditorUndo } from "./editorUndo";
const views: EditorView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); });
function fixture() {
  const scope = { conversationId: crypto.randomUUID(), manuscriptId: crypto.randomUUID(), proposalId: crypto.randomUUID(), operationId: crypto.randomUUID() };
  const undoId = crypto.randomUUID();
  const view = new EditorView({ state: EditorState.create({ doc: Text.of(["before\r", "中文"]), extensions: [writingEditorIdentity, history()] }) });
  views.push(view);
  const port = createWritingEditorSessionPort(view, `${scope.manuscriptId}:main.tex`), before = port.read()!;
  port.apply({ operationId: scope.operationId, expected: before, text: "after\r\n中文" });
  const baseline = port.read()!;
  let current: AgentEditorSessionPort | null = port, dispatched = false, revision: string | null = null;
  let lost = false, deferred = false, gate: Promise<void> | null = null;
  const state = () => ({ kind: "state", schemaVersion: 1, scope: { ...scope, operationId: undoId },
    status: revision ? "applied" : deferred ? "recoveryRequired" : "applying", files: [{ path: "main.tex",
      phase: revision ? "acknowledged" : dispatched ? "dispatched" : "pending", target: {
        kind: "editor", sessionId: baseline.sessionId, revision: baseline.revision, resultRevision: revision,
      } }] });
  const invoke = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const request = args.request as AgentUndoRequest, c = request.command;
    expect(request.scope).toEqual(scope); expect(request.undoId).toBe(undoId);
    if (c.action === "prepareEditor" && !dispatched) {
      expect(c.current.text).toBe(baseline.text);
      dispatched = true;
      if (gate) await gate;
      return { schemaVersion: 1, originalScope: scope, undoId, result: {
        kind: "edit", schemaVersion: 1, scope: { ...scope, operationId: undoId }, expected: c.current, text: before.text,
      } };
    }
    if (c.action === "defer") deferred = true;
    if (c.action === "confirmEditor") {
      if (lost) { lost = false; throw new Error("lost confirmation"); }
      revision = c.actual.revision;
    }
    return { schemaVersion: 1, originalScope: scope, undoId, result: state() };
  });
  const app = createWritingEditorUndo(createAgentUndoGateway(invoke), scope, undoId, () => current);
  return { app, view, port, undoId, invoke, lose: () => { lost = true; }, delay: (value: Promise<void>) => { gate = value; }, detach: () => { port.dispose(); current = null; } };
}
it("undo is one separate transaction and retains the original editor history", async () => {
  const f = fixture();
  expect((await f.app.apply("main.tex")).kind).toBe("state");
  expect(f.view.state.doc.toString()).toBe("before\r\n中文");
  expect(f.port.readReceipt(f.undoId)).not.toBeNull();
  expect(undo(f.view)).toBe(true); expect(f.view.state.doc.toString()).toBe("after\r\n中文");
  expect(undo(f.view)).toBe(true); expect(f.view.state.doc.toString()).toBe("before\r\n中文");
  const apply = vi.spyOn(f.port, "apply");
  await f.app.apply("main.tex"); expect(apply).not.toHaveBeenCalled();
});
it("confirms the saved receipt after later typing without replay", async () => {
  const f = fixture(); f.lose();
  expect((await f.app.apply("main.tex")).kind).toBe("unconfirmed");
  f.view.dispatch({ changes: { from: 0, insert: "later " } });
  const apply = vi.spyOn(f.port, "apply");
  const result = await f.app.recover("main.tex");
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(apply).not.toHaveBeenCalled(); expect(f.view.state.doc.toString()).toBe("later before\r\n中文");
});
it("recovery never starts a pending edit, and detach during dispatch cannot retarget", async () => {
  const f = fixture(); await f.app.recover("main.tex");
  expect(f.invoke.mock.calls.map(([, args]) => (args.request as AgentUndoRequest).command.action)).toEqual(["read"]);
  let release!: () => void; f.delay(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.app.apply("main.tex");
  await vi.waitFor(() => expect(f.invoke.mock.calls.length).toBe(2));
  expect((await f.app.apply("main.tex")).kind).toBe("busy");
  f.detach(); release(); expect((await pending).kind).toBe("unconfirmed");
  expect(f.view.state.doc.toString()).toBe("after\r\n中文");
});
it.each([false, true])("typing or IME invalidates a pending undo (%s)", async composing => {
  const f = fixture(); let release!: () => void;
  f.delay(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.app.apply("main.tex");
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalled());
  if (composing) vi.spyOn(f.view, "composing", "get").mockReturnValue(true);
  else f.view.dispatch({ changes: { from: 0, insert: "typed " } });
  release(); expect((await pending).kind).toBe("unconfirmed");
  const apply = vi.spyOn(f.port, "apply");
  expect((await f.app.recover("main.tex")).kind).toBe("unconfirmed");
  expect(apply).not.toHaveBeenCalled();
  expect(f.view.state.doc.toString()).toBe(composing ? "after\r\n中文" : "typed after\r\n中文");
});
it("recovers an exception after the editor committed using only its receipt", async () => {
  const f = fixture(), dispatch = f.view.dispatch.bind(f.view);
  const spy = vi.spyOn(f.view, "dispatch").mockImplementation((...args) => { dispatch(...args); throw new Error("after commit"); });
  expect((await f.app.apply("main.tex")).kind).toBe("unconfirmed");
  spy.mockClear();
  const result = await f.app.recover("main.tex");
  expect(result.kind === "state" && result.state.status).toBe("applied");
  expect(spy).not.toHaveBeenCalled();
});
