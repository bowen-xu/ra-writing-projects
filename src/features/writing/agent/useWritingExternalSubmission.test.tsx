/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import type {useAgentCanvasExternalSubmission} from "@research-assistant/workbench-sdk/agent-canvas";
import {WritingRuntimeAdmissionScope} from "../persistence/writingRuntimeAdmission";
import {useWritingExternalSubmission} from "./useWritingExternalSubmission";

const captured = vi.hoisted(() => ({send: null as Parameters<typeof useAgentCanvasExternalSubmission>[0] | null}));
vi.mock("@research-assistant/workbench-sdk/agent-canvas", () => ({useAgentCanvasExternalSubmission: (handler: Parameters<typeof useAgentCanvasExternalSubmission>[0]) => {captured.send = handler;}}));
const close: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of close.splice(0)) await cleanup();});
async function fixture() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let disabled = false, snapshot = {phase: "idle", preview: null as {requestId: string} | null};
  const admission = {isDisabled: () => disabled, subscribe: () => () => undefined};
  const submit = vi.fn(async () => {snapshot = {phase: "started", preview: {requestId: "next"}};});
  const options: Parameters<typeof useWritingExternalSubmission>[0] = {blocked: false, controller: {current: {getSnapshot: () => snapshot}}, submit};
  const root = createRoot(document.createElement("div"));
  function Host() {useWritingExternalSubmission(options); return null;}
  const render = async () => {await act(async () => root.render(<WritingRuntimeAdmissionScope value={admission}><Host /></WritingRuntimeAdmissionScope>));};
  close.push(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});
  await render();
  return {options, submit, render, send: () => captured.send!, disable: () => {disabled = true;},
    started: () => {snapshot = {phase: "started", preview: {requestId: "next"}};}};
}
it("reads the live instance getter before a new external dispatch from a stale render", async () => {
  const f = await fixture(); f.disable();
  await expect(f.send()("synthetic")).rejects.toMatchObject({code: "WRITING_RUNTIME_DISABLED"});
  expect(f.submit).not.toHaveBeenCalled();
});
it("rechecks after synchronous model selection before invoking the original submission", async () => {
  const f = await fixture();
  const options = f.options as {readModel?: () => undefined}; options.readModel = () => {f.disable(); return undefined;};
  await f.render();
  await expect(f.send()("synthetic")).rejects.toMatchObject({code: "WRITING_RUNTIME_DISABLED"}); expect(f.submit).not.toHaveBeenCalled();
});
it("retains an accepted asynchronous external acknowledgement after the instance is disabled", async () => {
  const f = await fixture(); let finish!: () => void;
  f.submit.mockImplementationOnce(() => new Promise<void>(resolve => {finish = () => {f.started(); resolve();};}));
  const sending = f.send()("synthetic"); expect(f.submit).toHaveBeenCalledOnce(); f.disable(); finish();
  await expect(sending).resolves.toBeUndefined();
});
it("rejects the original canvas message request while disabled without consuming a new dispatch", async () => {
  const f = await fixture(), resolve = vi.fn(), reject = vi.fn(); f.disable();
  const options = f.options as {messageRequest?: Parameters<typeof useWritingExternalSubmission>[0]["messageRequest"]};
  options.messageRequest = {text: "synthetic", resolve, reject}; await f.render();
  expect(reject).toHaveBeenCalledWith(expect.objectContaining({code: "WRITING_RUNTIME_DISABLED"}));
  expect(resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});
