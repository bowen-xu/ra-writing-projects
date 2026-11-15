/** @vitest-environment happy-dom */
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentApplicationResponse, AgentApplicationState } from "@research-assistant/core/agent";
import type { EditorApplicationResult } from "../editor/editorApplication";
import { WritingFileDeliveryRecovery, type WritingFileDeliveryRecoveryCommands } from "./WritingFileDeliveryRecovery";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({ notify: { warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
const scope = { manuscriptId: "manuscript", conversationId: "conversation", proposalId: "proposal", operationId: "original" };
const state: AgentApplicationState = { kind: "state", schemaVersion: 1, scope, status: "recoveryRequired", files: [
  { path: "main.tex", phase: "acknowledged", target: { kind: "disk" } },
  { path: "next.tex", phase: "pending", target: { kind: "disk" } },
] };
let root: Root, host: HTMLDivElement;
const execute = vi.fn<WritingFileDeliveryRecoveryCommands["gateway"]["execute"]>();
const accept = vi.fn<WritingFileDeliveryRecoveryCommands["accept"]>(), recover = vi.fn<WritingFileDeliveryRecoveryCommands["recover"]>(), rollback = vi.fn<WritingFileDeliveryRecoveryCommands["rollback"]>();
const onResult = vi.fn(async (_result: EditorApplicationResult) => undefined);
const commands: WritingFileDeliveryRecoveryCommands = { gateway: { execute, find: vi.fn(async () => null) }, accept, recover, rollback };
beforeEach(() => {
  vi.resetAllMocks(); execute.mockResolvedValue(state);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(application = state, disabled = false) {
  await act(async () => root.render(<WritingFileDeliveryRecovery application={application} commands={commands} disabled={disabled} onResult={onResult} />));
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
it("refreshes terminal progress without invoking file commands or confirming saving", async () => {
  const terminal = { ...state, status: "rolledBack" as const };
  execute.mockResolvedValue(terminal); await render();
  await act(async () => button("刷新文件操作状态").click());
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: "read", scope });
  expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "unconfirmed", state: terminal });
  expect(accept).not.toHaveBeenCalled(); expect(rollback).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
});
it("reads fresh state before compensation, excludes duplicate clicks and preserves a save failure", async () => {
  let resolve!: (result: EditorApplicationResult) => void;
  rollback.mockImplementation(() => new Promise(result => { resolve = result; }));
  await render();
  await act(async () => { button("恢复应用前内容").click(); button("恢复应用前内容").click(); });
  expect(rollback).toHaveBeenCalledExactlyOnceWith(scope);
  expect(button("刷新文件操作状态").disabled).toBe(true);
  const terminal = { ...state, status: "rolledBack" as const };
  // The host is disabled while a protected lease is held. Keep this result.
  await render(state, true);
  await act(async () => resolve({ kind: "unconfirmed", state: terminal }));
  expect(onResult).toHaveBeenLastCalledWith({ kind: "unconfirmed", state: terminal });
  expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("尚未确认"), expect.anything());
  execute.mockResolvedValue(terminal); rollback.mockResolvedValue({ kind: "state", state: terminal });
  await render(terminal);
  await act(async () => button("重试保存文件结果").click());
  expect(rollback).toHaveBeenCalledTimes(2); expect(accept).not.toHaveBeenCalled();
  expect(onResult).toHaveBeenLastCalledWith({ kind: "state", state: terminal });
});
it("does not compensate when a fresh read has a conflict and rejects another operation's read", async () => {
  execute.mockResolvedValue({ ...state, files: state.files.map(file => ({ ...file, phase: "conflict" })) });
  await render(); await act(async () => button("恢复应用前内容").click());
  expect(rollback).not.toHaveBeenCalled();
  execute.mockResolvedValue({ ...state, scope: { ...scope, operationId: "foreign" } });
  onResult.mockClear(); await act(async () => button("刷新文件操作状态").click());
  expect(onResult).not.toHaveBeenCalled(); expect(notify.error).toHaveBeenCalledWith(expect.stringContaining("尚未确认"), expect.anything());
});
it("reconciles original dispatched receipts without continuing or saving even if the native log becomes applied", async () => {
  const dispatched = { ...state, files: state.files.map(file => ({ ...file, phase: "dispatched" as const })) };
  execute.mockResolvedValue(dispatched);
  const completed = { ...state, status: "applied" as const, files: state.files.map(file => ({ ...file, phase: "acknowledged" as const })) };
  recover.mockResolvedValue({ kind: "state", state: completed });
  await render(dispatched); await act(async () => button("核对文件结果").click());
  expect(recover.mock.calls).toEqual([[scope, "main.tex"], [scope, "next.tex"]]);
  expect(onResult.mock.calls.every(([result]) => result.kind === "unconfirmed")).toBe(true);
  expect(accept).not.toHaveBeenCalled(); expect(rollback).not.toHaveBeenCalled();
});
it.each(["replace", "unmount"])("ignores a delayed read after %s", async change => {
  let resolve!: (result: AgentApplicationResponse) => void;
  execute.mockImplementation(() => new Promise(result => { resolve = result; }));
  await render(); await act(async () => button("恢复应用前内容").click());
  if (change === "replace") await render({ ...state, scope: { ...scope, manuscriptId: "other" } });
  else await act(async () => root.render(null));
  await act(async () => resolve(state));
  expect(onResult).not.toHaveBeenCalled(); expect(rollback).not.toHaveBeenCalled();
});
