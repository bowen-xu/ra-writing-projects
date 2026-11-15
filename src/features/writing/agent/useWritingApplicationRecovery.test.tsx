/** @vitest-environment happy-dom */
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentApplicationState, AgentPendingWritingApplicationPage } from "@research-assistant/core/agent";
import type { AgentPendingWritingApplicationGateway } from "@research-assistant/data/agent";
import { useWritingApplicationRecovery } from "./useWritingApplicationRecovery";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function application(manuscriptId: string): AgentApplicationState {
  return { schemaVersion: 1, kind: "state", scope: { manuscriptId, conversationId: crypto.randomUUID(),
    proposalId: crypto.randomUUID(), operationId: crypto.randomUUID() }, status: "recoveryRequired",
  files: [{ path: "main.tex", phase: "dispatched", target: { kind: "disk" } }] };
}
const page = (manuscriptId: string, states: readonly AgentApplicationState[] = [], nextCursor: number | null = null): AgentPendingWritingApplicationPage =>
  ({ schemaVersion: 1, manuscriptId, items: states.map((application, index) => ({ id: index + 1, application })), nextCursor });
function delayed<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(strict = false) {
  const manuscriptId = crypto.randomUUID(), state = application(manuscriptId), workspace = {};
  const gateway = { list: vi.fn<AgentPendingWritingApplicationGateway["list"]>(async request => page(request.manuscriptId)) };
  const host = document.createElement("div"), root = createRoot(host);
  let api!: ReturnType<typeof useWritingApplicationRecovery>;
  function Harness({ manuscript, identity, discovery }: { manuscript: string; identity: object; discovery: AgentPendingWritingApplicationGateway }) {
    api = useWritingApplicationRecovery(manuscript, discovery, identity); return null;
  }
  const render = async (manuscript = manuscriptId, identity = workspace, discovery: AgentPendingWritingApplicationGateway = gateway) => {
    await act(async () => root.render(strict ? <StrictMode><Harness manuscript={manuscript} identity={identity} discovery={discovery} /></StrictMode>
      : <Harness manuscript={manuscript} identity={identity} discovery={discovery} />));
  };
  cleanups.push(async () => { await act(async () => root.unmount()); });
  return { manuscriptId, state, workspace, gateway, render, api: () => api };
}
it("discovers file journals with no chat identity or execution and remains pending until protected completion", async () => {
  const f = await fixture(); f.gateway.list.mockResolvedValueOnce(page(f.manuscriptId, [f.state])); await f.render();
  expect(f.gateway.list).toHaveBeenCalledExactlyOnceWith({ manuscriptId: f.manuscriptId, after: null, limit: 64 });
  expect(f.api().entries[0]?.state).toEqual(f.state); expect(f.api().pending).toBe(true);
  const terminal = { ...f.state, status: "applied" as const };
  await act(async () => f.api().record(f.state, { kind: "unconfirmed", state: terminal }));
  expect(f.api().pending).toBe(true); expect(f.api().entries[0]?.state.status).toBe("applied");
  await act(async () => f.api().record(f.state, { kind: "state", state: { ...terminal, scope: { ...terminal.scope, operationId: crypto.randomUUID() } } }));
  expect(f.api().pending).toBe(true);
  await act(async () => f.api().record(f.state, { kind: "state", state: terminal }));
  expect(f.api().pending).toBe(false);
});
it("holds delivery after a later-page failure and retries without clearing earlier observations", async () => {
  const f = await fixture(), other = application(f.manuscriptId);
  f.gateway.list.mockResolvedValueOnce(page(f.manuscriptId, [f.state], 1)).mockRejectedValueOnce(new Error("offline"));
  await f.render(); expect(f.api().failed).toBe(true); expect(f.api().entries).toHaveLength(1);
  f.gateway.list.mockResolvedValueOnce(page(f.manuscriptId, [f.state, other]));
  await act(async () => f.api().retry());
  expect(f.api().failed).toBe(false); expect(f.api().entries).toHaveLength(2);
  expect(f.gateway.list.mock.calls[1]?.[0].after).toBe(1);
});
it("ignores late old-manuscript pages and stale local commands after selection changes", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingApplicationPage>(), otherId = crypto.randomUUID();
  f.gateway.list.mockReturnValueOnce(wait.promise); await f.render(); const old = f.api();
  await f.render(otherId);
  await act(async () => { wait.resolve(page(f.manuscriptId, [f.state])); old.observe(f.state); });
  expect(f.api().entries).toEqual([]); expect(f.api().pending).toBe(false);
});
it("does not resurrect a locally completed application from a delayed snapshot", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingApplicationPage>();
  f.gateway.list.mockReturnValueOnce(wait.promise); await f.render(); expect(f.api().loading).toBe(true);
  await act(async () => f.api().record(f.state, { kind: "state", state: { ...f.state, status: "rolledBack" } }));
  await act(async () => wait.resolve(page(f.manuscriptId, [f.state])));
  expect(f.api().pending).toBe(false); expect(f.api().entries).toEqual([]);
});
it("keeps a newer terminal save wait across file owner replacement and an empty scan", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingApplicationPage>();
  f.gateway.list.mockReturnValueOnce(wait.promise); await f.render();
  await act(async () => f.api().record(f.state, { kind: "unconfirmed", state: { ...f.state, status: "applied" } }));
  await act(async () => wait.resolve(page(f.manuscriptId, [f.state])));
  await f.render(f.manuscriptId, {});
  expect(f.api().entries[0]?.state.status).toBe("applied"); expect(f.api().pending).toBe(true);
});
it("rejects late pages and callbacks when the gateway owner is replaced", async () => {
  const f = await fixture(), wait = delayed<AgentPendingWritingApplicationPage>();
  f.gateway.list.mockReturnValueOnce(wait.promise); await f.render(); const old = f.api();
  await f.render(f.manuscriptId, f.workspace, { list: async () => page(f.manuscriptId) });
  await act(async () => { wait.resolve(page(f.manuscriptId, [f.state])); old.observe(f.state); });
  expect(f.api().pending).toBe(false); expect(f.api().entries).toEqual([]);
});
it.each(["duplicate", "nonprogressing cursor"])("fails closed on %s pages", async fault => {
  const f = await fixture();
  f.gateway.list.mockResolvedValueOnce(page(f.manuscriptId, [f.state], 1))
    .mockResolvedValueOnce(page(f.manuscriptId, fault === "duplicate" ? [f.state] : [], fault === "duplicate" ? null : 1));
  await f.render(); expect(f.api().failed).toBe(true); expect(f.api().pending).toBe(true);
  expect(f.api().entries).toHaveLength(1); expect(f.gateway.list).toHaveBeenCalledTimes(2);
});
it("reads original operation state immediately before a batched React projection commits", async () => {
  const f = await fixture(); await f.render();
  const query = f.api().hasPending;
  expect(query()).toBe(false);
  const other = application(f.manuscriptId), terminal = { ...f.state, status: "applied" as const };
  await act(async () => {
    f.api().observe(f.state); expect(query()).toBe(true);
    f.api().observe(other);
    f.api().record(f.state, {kind: "state", state: terminal}); expect(query()).toBe(true);
    f.api().record(other, {kind: "unconfirmed", state: {...other, status: "applied"}}); expect(query()).toBe(true);
  });
  expect(f.api().entries.map(entry => entry.scope.operationId)).toEqual([other.scope.operationId]);
  await act(async () => {
    f.api().record(other, {kind: "state", state: {...other, status: "applied"}});
    expect(query()).toBe(false);
  });
});
it("retains the live scan barrier across StrictMode, retry and owner replacement", async () => {
  const f = await fixture(true), oldScan = delayed<AgentPendingWritingApplicationPage>();
  f.gateway.list.mockReturnValueOnce(oldScan.promise).mockResolvedValueOnce(page(f.manuscriptId));
  await f.render(); const query = f.api().hasPending, old = f.api();
  expect(f.gateway.list).toHaveBeenCalledTimes(2); expect(query()).toBe(false);
  const next = delayed<AgentPendingWritingApplicationPage>();
  f.gateway.list.mockReturnValueOnce(next.promise);
  await f.render(f.manuscriptId, {});
  expect(query()).toBe(true);
  await act(async () => {oldScan.resolve(page(f.manuscriptId, [f.state])); old.observe(f.state);});
  expect(f.api().entries).toEqual([]); expect(query()).toBe(true);
  await act(async () => next.resolve(page(f.manuscriptId))); expect(query()).toBe(false);
  f.gateway.list.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => {f.api().retry(); expect(query()).toBe(true);});
  expect(query()).toBe(true); expect(f.api().failed).toBe(true);
  await act(async () => {f.api().retry(); expect(query()).toBe(true);});
  expect(query()).toBe(false);
});
