/** @vitest-environment happy-dom */
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { afterEach, expect, it, vi } from "vitest";
import { createWritingEditorSessionPort } from "./editorSessionPort";
import { writingEditorIdentity } from "./editorSession";

const views: EditorView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); });
function fixture(extra: Parameters<typeof EditorState.create>[0] = {}) {
  const view = new EditorView({state:EditorState.create({doc:"left middle right",...extra,
    extensions:[writingEditorIdentity,history(),...(extra.extensions ? [extra.extensions] : [])]})});
  views.push(view);
  return {view,port:createWritingEditorSessionPort(view,"paper:main.tex")};
}
it("isolates an accepted multi-range edit from preceding and following typing and preserves selection", () => {
  const {view,port} = fixture();
  view.dispatch({changes:{from:17,insert:"!"},annotations:Transaction.userEvent.of("input.type")});
  view.dispatch({selection:{anchor:7}});
  const expected = port.read()!;
  const result = port.apply({operationId:"one",expected,text:"LEFT middle RIGHT!"});
  expect(result.status).toBe("applied");
  expect(view.state.selection.main.anchor).toBe(7);
  expect(port.read()!.revision).not.toBe(expected.revision);
  expect(port.read()!.sessionId).toBe(expected.sessionId);
  view.dispatch({changes:{from:18,insert:"?"},annotations:Transaction.userEvent.of("input.type")});
  expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("LEFT middle RIGHT!");
  expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("left middle right!");
  expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("left middle right");
  expect(redo(view)).toBe(true); expect(redo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("LEFT middle RIGHT!");
});
it("rejects stale versions, wrong identity, and altered expected text without dispatch", () => {
  const {view,port} = fixture(); const expected=port.read()!;
  for (const changed of [{...expected,documentKey:"other"},{...expected,sessionId:"other"},{...expected,revision:"other"},{...expected,text:"different"}]) {
    expect(port.apply({operationId:"one",expected:changed,text:"new"}).status).toBe("conflict");
    expect(port.read()).toEqual(expected);
  }
  view.dispatch({changes:{from:0,insert:"typed "}});
  expect(port.apply({operationId:"one",expected,text:"new"}).status).toBe("conflict");
  expect(view.state.doc.toString()).toBe("typed left middle right");
});
it("retries return the historical receipt without reapplying after undo and cannot reuse an ID for different content", () => {
  const {view,port}=fixture(); const edit={operationId:"one",expected:port.read()!,text:"changed 中文"};
  const result=port.apply(edit);
  expect(port.apply(edit)).toEqual(result);
  expect(undo(view)).toBe(true);
  expect(port.apply(edit)).toEqual(result);
  expect(view.state.doc.toString()).toBe("left middle right");
  expect(port.apply({...edit,text:"injected"}).status).toBe("conflict");
  // Returned objects cannot mutate the receipt.
  if(result.status === "applied") Object.assign(result.snapshot,{text:"corrupt"});
  const retried=port.apply(edit);
  expect(retried.status === "applied" && retried.snapshot.text).toBe(edit.text);
});
it("fails closed for destroyed, readonly or filtered editors", () => {
  const {view,port}=fixture(); const edit={operationId:"one",expected:port.read()!,text:"new"};
  port.dispose(); view.destroy(); expect(port.read()).toBeNull(); expect(port.apply(edit).status).toBe("unavailable");
  const readonly=fixture({extensions:EditorState.readOnly.of(true)});
  expect(readonly.port.apply({...edit,expected:readonly.port.read()!}).status).toBe("unavailable");
  const filtered=fixture({extensions:EditorState.changeFilter.of(() => false)});
  const before=filtered.port.read()!;
  expect(filtered.port.apply({...edit,expected:before}).status).toBe("conflict");
  expect(filtered.port.read()).toEqual(before);
});
it("preserves Unicode and CRLF without implicit normalization", () => {
  const {port}=fixture({doc:"a😀b\n中文"});
  expect(port.apply({operationId:"one",expected:port.read()!,text:"a😃b\n文献"}).status).toBe("applied");
  const expected=port.read()!;
  expect(port.apply({operationId:"two",expected,text:"a\r\nb"}).status).toBe("applied");
  expect(port.read()!.text).toBe("a\r\nb");
});
it("does not interfere with composition and reports a dispatch failure as uncertain", () => {
  const {view,port}=fixture(); const edit={operationId:"one",expected:port.read()!,text:"new"};
  const composing=vi.spyOn(view,"composing","get").mockReturnValue(true);
  expect(port.apply(edit).status).toBe("unavailable"); composing.mockRestore();
  const dispatch=view.dispatch.bind(view);
  vi.spyOn(view,"dispatch").mockImplementation((...transactions) => { dispatch(...transactions); throw new Error("after apply"); });
  expect(port.apply(edit).status).toBe("unconfirmed");
  expect(port.read()!.text).toBe("new");
  const receipt = port.readReceipt("one");
  expect(receipt?.snapshot.text).toBe("new");
  expect(receipt?.snapshot.revision).not.toBe(edit.expected.revision);
  expect(port.apply(edit)).toEqual(receipt);
});

it("reads historical receipts without a dispatch after typing or undo and isolates returned values", () => {
  const {view,port}=fixture();
  const edit={operationId:"one",expected:port.read()!,text:"accepted"};
  expect(port.readReceipt("one")).toBeNull();
  const result=port.apply(edit);
  const dispatch=vi.spyOn(view,"dispatch");
  expect(port.readReceipt("other")).toBeNull();
  expect(port.readReceipt("one")).toEqual(result);
  expect(dispatch).not.toHaveBeenCalled();
  const copy=port.readReceipt("one")!;
  Object.assign(copy.snapshot,{text:"corrupted"});
  expect(port.readReceipt("one")).toEqual(result);
  expect(undo(view)).toBe(true);
  const snapshot=port.read();
  dispatch.mockClear();
  expect(port.readReceipt("one")).toEqual(result);
  expect(port.read()).toEqual(snapshot);
  expect(dispatch).not.toHaveBeenCalled();
  port.dispose();
  expect(port.readReceipt("one")).toBeNull();
});

it("does not manufacture a receipt for rejected or unreadable dispatch and evicts old receipts", () => {
  const {view,port}=fixture();
  const baseline=port.read()!;
  expect(port.apply({operationId:"empty",expected:baseline,text:baseline.text}).status).toBe("conflict");
  expect(port.readReceipt("empty")).toBeNull();
  expect(port.read()).toEqual(baseline);
  const edit={operationId:"one",expected:port.read()!,text:"accepted"};
  const throwing=vi.spyOn(view,"dispatch").mockImplementation(() => { throw new Error("before dispatch"); });
  expect(port.apply(edit).status).toBe("unconfirmed");
  expect(port.readReceipt("one")).toBeNull();
  throwing.mockRestore();
  expect(port.apply(edit).status).toBe("applied");
  expect(port.apply({operationId:"two",expected:port.read()!,text:"second"}).status).toBe("applied");
  expect(port.readReceipt("one")).toBeNull();
  expect(port.readReceipt("two")?.snapshot.text).toBe("second");
});
