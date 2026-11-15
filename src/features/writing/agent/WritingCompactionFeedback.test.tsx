/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSubmissionPreview } from "@research-assistant/core/agent";
import { WritingCompactionFeedback, writingCompactionDiagnostic } from "./WritingCompactionFeedback";
import {WritingCompactionAdmissionClosed} from "./writingCompactionAdmission";
import {writingPreparationMessage} from "../../../../../../apps/web/src/core/features/agent/writingPreparationMessage";
import type {WritingPreparationSnapshot} from "../../../../../../apps/web/src/core/features/agent/writingPreparation";

type Props = Parameters<typeof WritingCompactionFeedback>[0];
type State = NonNullable<Props["state"]>;
it("projects a local unsent admission block with only its actual safe identity", () => {
  const identity = {conversationId: "11111111-1111-4111-8111-111111111111", manuscriptId: "22222222-2222-4222-8222-222222222222", requestId: "33333333-3333-4333-8333-333333333333"};
  const cause = new WritingCompactionAdmissionClosed("start", true, identity);
  const diagnostic = writingCompactionDiagnostic(cause);
  expect(diagnostic).toContain("插件已停用"); expect(diagnostic).toContain("尚未派发");
  for (const value of [cause.code, "step=start", `C=${identity.conversationId}`, `M=${identity.manuscriptId}`, `R=${identity.requestId}`]) expect(diagnostic).toContain(value);
  expect(diagnostic).not.toContain("COMPACTION_RESULT_UNCONFIRMED");
  expect(writingCompactionDiagnostic({code: cause.code, step: "start", identity: {body: "PRIVATE"}})).not.toContain("PRIVATE");
});
const conversationId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const preview: AgentSubmissionPreview & { expectedRevision: number } = {
  schemaVersion: 1, conversationId, requestId, manuscriptId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444", contextSnapshotId: "55555555-5555-4555-8555-555555555555",
  input: { text: "PRIVATE_SOURCE_BODY", model: { providerId: "openai", modelId: "gpt-5.6-terra", revision: "synthetic-v1" },
    reasoningEffort: null, context: [] }, expectedRevision: 123,
};
const initial: State = { phase: "preview", request: null, recoveryReceipt: null, preview, admission: null,
  error: null, outcome: null, stopPending: false, stopRequested: false };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function render(state: State, overrides: Partial<Props> = {}) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const writeText = vi.fn(async (_value: string) => undefined);
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});
  const host = document.createElement("div"), root = createRoot(host);
  const retry = vi.fn(async () => false), dismiss = vi.fn(() => true), stop = vi.fn(async () => {});
  const props: Props = { state, history: null, issue: null, restored: true, retry, dismiss, stop, ...overrides };
  await act(async () => root.render(<WritingCompactionFeedback {...props} />));
  cleanups.push(async () => { await act(async () => root.unmount()); });
  const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label);
  const diagnostic = async () => { await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="复制诊断信息"]')!.click()); return writeText.mock.lastCall?.[0] ?? ""; };
  return { host, retry, dismiss, stop, button, diagnostic };
}
function preparationDiagnostics(cause: unknown): readonly string[] {
  const state: WritingPreparationSnapshot = {phase: "unknown", intent: null, result: null, status: null, knownCommitted: false,
    priorUnknown: true, knownRejected: false, recovered: false, workspaceBuffers: null, workspaceReady: false, cause, draftAcknowledgment: null, start: null, startStatus: null};
  return [writingPreparationMessage({...state, cause}), writingCompactionDiagnostic(cause)];
}
it("preserves the native domain code, original identities and an exact static catalog reason in both preparation formatters", () => {
  const cause = {code: "storage", reason: {conversationId, manuscriptId: preview.manuscriptId, requestId, operationId: requestId,
    code: "DATA_SQL_DOMAIN", reason: "conversation not found", message: "PRIVATE_PROVIDER_BODY"}};
  for (const message of preparationDiagnostics(cause)) {
    for (const value of ["code=DATA_SQL_DOMAIN", `C=${conversationId}`, `M=${preview.manuscriptId}`, `R=${requestId}`, `operationId=${requestId}`, "reason=conversation not found"])
      expect(message).toContain(value);
    expect(message).not.toContain("PRIVATE_PROVIDER_BODY");
  }
});
it("retains a domain code without disclosing unknown reasons, malformed IDs or arbitrary nested fields", () => {
  for (const reason of ["PRIVATE_SOURCE_BODY", {message: "PRIVATE_SOURCE_BODY"}]) {
    const cause = {code: "storage", reason: {conversationId: "PRIVATE_PATH", requestId, operationId: "PRIVATE_TOKEN", code: "DATA_SQL_DOMAIN", reason}};
    for (const message of preparationDiagnostics(cause)) {
      expect(message).toContain("code=DATA_SQL_DOMAIN"); expect(message).toContain(`R=${requestId}`);
      expect(message).not.toMatch(/PRIVATE_|reason=/u);
    }
  }
});

it("shows missing original owner as an unconfirmed request without automatically replaying it", async () => {
  const cause=Object.assign(new Error("agent_preview_owner_intent_missing"),{code:"AGENT_PREVIEW_OWNER_INTENT_MISSING"});
  for (const message of preparationDiagnostics(cause)) {
    expect(message).toContain("原请求的归属尚无法确认");
    expect(message).toContain("AGENT_PREVIEW_OWNER_INTENT_MISSING");
  }
  const h=await render({...initial,phase:"error",error:"prepare",cause});
  expect(h.host.textContent).toContain("原请求的归属尚无法确认");
  expect(h.retry).not.toHaveBeenCalled();
  expect(await h.diagnostic()).toContain("AGENT_PREVIEW_OWNER_INTENT_MISSING");
});

it("discloses the frozen model, boundary and original receipt without automatically retrying", async () => {
  const h = await render(initial);
  expect(h.host.textContent).toContain("openai/gpt-5.6-terra");
  expect(h.host.textContent).toContain("历史水位：123");
  expect(h.host.textContent).not.toContain(`C=${conversationId}`);
  expect(h.host.textContent).not.toContain("PRIVATE_SOURCE_BODY");
  expect(h.retry).not.toHaveBeenCalled();
  expect(h.button("关闭提示")).toBeUndefined();
  expect(h.button("停止原压缩请求")).toBeUndefined();
  await act(async () => h.button("确认并继续原压缩请求")!.click());
  expect(h.retry).toHaveBeenCalledTimes(1);
});

it("shows allowlisted history-conflict diagnostics without provider messages or arbitrary JSON", async () => {
  const h = await render({ ...initial, phase: "error", error: "startRejected", cause: {
    code: "historyChanged", reason: { expected: 123, actual: 987 },
    message: "PRIVATE_PROVIDER_RESPONSE", requestBody: "PRIVATE_SOURCE_BODY",
  } }, { restored: false });
  const details = await h.diagnostic();
  expect(details).toContain("错误码：historyChanged");
  expect(details).toContain("expected=123；actual=987");
  expect(h.host.textContent).not.toMatch(/PRIVATE_|requestBody/);
  expect(h.button("核对原压缩请求")).toBeUndefined();
  await act(async () => h.button("关闭提示")!.click());
  expect(h.dismiss).toHaveBeenCalledTimes(1);
  expect(h.retry).not.toHaveBeenCalled();
});

it("keeps an unknown start recoverable and treats a stop acknowledgement as waiting for history", async () => {
  const h = await render({ ...initial, phase: "error", error: "start", stopRequested: true,
    cause: { code: "unrecognizedProviderPayload", message: "PRIVATE_PROVIDER_RESPONSE" } }, {
    history: { status: "error", projection: null, error: new Error("PRIVATE_PROVIDER_RESPONSE") },
  });
  expect(h.host.textContent).toContain("已请求停止，等待历史确认");
  expect(h.host.textContent).toContain("尚未确认执行是否结束");
  expect(await h.diagnostic()).toContain("本机诊断码：COMPACTION_RESULT_UNCONFIRMED");
  expect(h.host.textContent).not.toMatch(/PRIVATE_|unrecognizedProviderPayload|上下文已压缩/);
  expect(h.button("关闭提示")).toBeUndefined();
  expect(h.button("停止原压缩请求")).toBeUndefined();
  await act(async () => h.button("核对原压缩请求")!.click());
  expect(h.retry).toHaveBeenCalledTimes(1);
  expect(h.stop).not.toHaveBeenCalled();
});
it.each([true, false])("deduplicates identical formatted diagnostics while retaining distinct issue causes (same=%s)", async same => {
  const code = "AGENT_PREVIEW_SYNTHETIC_IO_ACK_LOST", issue = same ? {code, message: "PRIVATE_PROVIDER_RESPONSE"}
    : {code: "DATA_SQL_DOMAIN", reason: "conversation not found"};
  const h = await render({...initial, phase: "error", error: "prepare", cause: new Error(code)}, {issue: same ? issue
    : {code: "storage", reason: {conversationId, requestId, operationId: requestId, ...issue}}});
  expect(h.host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  const details = await h.diagnostic();
  expect(details).toContain(code);
  expect(details.match(new RegExp(code, "g"))).toHaveLength(1);
  if (!same) expect(details).toContain("code=DATA_SQL_DOMAIN");
  expect(h.host.textContent).not.toContain("PRIVATE_PROVIDER_RESPONSE");
  expect(details).toContain(`C=${conversationId}`); expect(details).toContain(`R=${requestId}`);
  expect(h.retry).not.toHaveBeenCalled(); expect(h.button("核对原准备记录并继续")).toBeDefined();
});

it("offers the owned stop action only for an unresolved admitted request", async () => {
  const h = await render({ ...initial, phase: "error", error: "start", cause: { code: "recoveryRequired" } });
  expect(h.stop).not.toHaveBeenCalled();
  await act(async () => h.button("停止原压缩请求")!.click());
  expect(h.stop).toHaveBeenCalledTimes(1);
  expect(h.retry).not.toHaveBeenCalled();
});

it("keeps terminal queue settlement recoverable with original identities and safe nested conflict diagnostics", async () => {
  const inputId = "66666666-6666-4666-8666-666666666666", operationId = "77777777-7777-4777-8777-777777777777";
  const settle = {operationId, conversationId, manuscriptId: preview.manuscriptId, inputId, requestId, expectedQueueRevision: 4, claimRevision: 2};
  const h = await render({...initial, phase: "started", outcome: "failed"}, {queuedPending: true,
    issue: {code: "queue", reason: {code: "conflict", message: "PRIVATE_SOURCE_BODY"}},
    queuedRecovery: {conversationId, manuscriptId: preview.manuscriptId, requestId, inputId, queued: {prepare: null, settle}},
    settlement: {phase: "error", request: settle, result: null, cause: null}});
  const details = await h.diagnostic();
  expect(details).toContain("错误码：queue；queue=conflict");
  expect(details).toContain(`I=${inputId}`); expect(details).toContain(`E=${operationId}`);
  expect(h.host.textContent).not.toContain("PRIVATE_SOURCE_BODY"); expect(h.button("关闭提示")).toBeUndefined();
  await act(async () => h.button("核对原队列压缩收尾")!.click()); expect(h.retry).toHaveBeenCalledOnce();
});

it.each(["completed", "failed", "canceled", "interrupted"] as const)("offers explicit settlement after restoring a %s queued request without an error", async outcome => {
  const inputId = "66666666-6666-4666-8666-666666666666";
  const h = await render({...initial, phase: "started", outcome}, {queuedPending: true,
    queuedRecovery: {conversationId, manuscriptId: preview.manuscriptId, requestId, inputId, queued: {prepare: null, settle: null}},
    settlement: {phase: "pending", request: null, result: null, cause: null}});
  const details = await h.diagnostic();
  expect(details).toContain(`R=${requestId}`);
  expect(details).toContain(`I=${inputId}`);
  expect(h.button("关闭提示")).toBeUndefined();
  expect(h.button("停止原压缩请求")).toBeUndefined();
  expect(h.retry).not.toHaveBeenCalled();
  await act(async () => h.button("核对原队列压缩收尾")!.click());
  expect(h.retry).toHaveBeenCalledOnce();
  expect(h.stop).not.toHaveBeenCalled();
});

it.each(["DATA_RUNTIME_ADMISSION", "data_recovery_required"])("keeps the stable %s code without arbitrary response fields", async code => {
  const h = await render({...initial, phase: "started"}, {history: {status: "error", projection: null,
    error: {code, message: "PRIVATE_PROVIDER_RESPONSE", body: "PRIVATE_SOURCE_BODY"}}});
  expect(await h.diagnostic()).toContain(`错误码：${code}`); expect(h.host.textContent).not.toMatch(/PRIVATE_|上下文压缩失败/);
  expect(h.button("重新读取原请求历史")).toBeDefined();
});

it("labels a restored preview's failed history retry as a read instead of execution confirmation", async () => {
  const h = await render(initial, { history: { status: "error", projection: null, error: { code: "unavailable" } } });
  expect(h.host.textContent?.match(/无法读取压缩历史，尚未确认执行是否结束。/gu)).toHaveLength(1);
  expect(h.button("确认并继续原压缩请求")).toBeUndefined();
  expect(h.button("停止原压缩请求")).toBeUndefined();
  expect(h.retry).not.toHaveBeenCalled();
  await act(async () => h.button("重新读取原请求历史")!.click());
  expect(h.retry).toHaveBeenCalledTimes(1);
});

it.each(["historyChanged", "confirmationMismatch"])("permits a restored %s request to be abandoned only with post-lookup non-admission proof", async code => {
  const h = await render({ ...initial, phase: "error", error: "startRejected", cause: {
    code, reason: { expected: 123, actual: 456 },
  } });
  expect(h.button("关闭提示")).toBeUndefined();
  const abandon = h.button("放弃原压缩请求");
  if (code === "historyChanged") {
    expect(abandon).toBeDefined();
    await act(async () => abandon!.click());
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  } else {
    expect(abandon).toBeUndefined();
    expect(h.dismiss).not.toHaveBeenCalled();
  }
  expect(h.retry).not.toHaveBeenCalled();
});

it.each([null, "completed"] as const)("leaves normal activity and terminal %s to the durable transcript", async outcome => {
  const h = await render({ ...initial, phase: "started", outcome });
  expect(h.host.childElementCount).toBe(0);
});

it("uses the shared SDK formatter for queued preparation source failures", () => {
  const inputId = "44444444-4444-4444-8444-444444444444";
  const nativeId = "55555555-5555-4555-8555-555555555555";
  const message = writingCompactionDiagnostic({code: "queue", reason: {code: "unavailable"}, writingSource: {
    conversationId, manuscriptId: preview.manuscriptId, operationId: requestId, inputId,
    source: {kind: "native", packageKey: "a".repeat(64), instanceId: nativeId,
      requestId: nativeId, rejection: "conflict", body: "PRIVATE_SOURCE_BODY"},
  }});
  for (const value of ["reason=unavailable", `inputId=${inputId}`, `nativeRequestId=${nativeId}`,
    `packageKey=${"a".repeat(64)}`, "source.rejection=conflict"]) expect(message).toContain(value);
  expect(message).not.toContain("PRIVATE_SOURCE_BODY");
});
