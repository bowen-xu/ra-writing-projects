// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from "vitest";
import type {WritingGateway} from "./writingGateway";
import {observeWritingNotes} from "./observeWritingNotes";

afterEach(()=>vi.restoreAllMocks());

it("keeps one observer when application assembly selects an already-observed port",async()=>{
  const result={content:"saved"};
  const saveFile=vi.fn(async()=>result);
  const source={saveFile} as unknown as WritingGateway;
  const adapter=observeWritingNotes(source);
  const dispatch=vi.spyOn(window,"dispatchEvent");
  expect(observeWritingNotes(source)).toBe(adapter);
  expect(observeWritingNotes(adapter)).toBe(adapter);
  expect(observeWritingNotes(observeWritingNotes(adapter))).toBe(adapter);
  expect(await Reflect.apply(adapter.saveFile,adapter,[{}])).toBe(result);
  expect(saveFile).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls.filter(([event])=>event.type==="research-assistant:writing-notes-changed")).toHaveLength(1);
});

it("does not publish successful invalidation when the underlying mutation fails",async()=>{
  const reason=new Error("source write failed");
  const source={saveFile:vi.fn(async()=>{throw reason;})} as unknown as WritingGateway;
  const adapter=observeWritingNotes(observeWritingNotes(source));
  const dispatch=vi.spyOn(window,"dispatchEvent");
  await expect(Reflect.apply(adapter.saveFile,adapter,[{}])).rejects.toBe(reason);
  expect(dispatch).not.toHaveBeenCalled();
});
