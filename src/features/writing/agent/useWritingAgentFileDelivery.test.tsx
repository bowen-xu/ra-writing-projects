/** @vitest-environment happy-dom */
import { createHash } from "node:crypto";
import { notify } from "../../../../../../apps/web/src/core/public/feedback";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAgentEvent, type AgentApplicationScope, type AgentHistoryResponse, type AgentProposalReview, type AgentWritingFileDeliveryPage } from "@research-assistant/core/agent";
import { parseManuscriptPath, type WritingCheckpointRecord } from "@research-assistant/writing";
import { undo } from "@codemirror/commands";
import type { WritingGateway } from "../gateway";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { WritingCheckpointPersistence } from "../persistence/WritingCheckpointPersistence";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { useWritingAgentFileDelivery, type WritingAgentFileDeliveryGateways } from "./useWritingAgentFileDelivery";
import raw from "../../../../../../tests/fixtures/agent-events-v1.json";

const desktop = vi.hoisted(() => ({ create: vi.fn(), open: vi.fn(), readHistory: vi.fn(), waitForHistory: vi.fn(() => new Promise<never>(() => undefined)),
  latest: vi.fn(), publish: vi.fn(), review: vi.fn(), reviewBinding: vi.fn(), readFile: vi.fn(),
  list: vi.fn(async (request: { manuscriptId: string }): Promise<AgentWritingFileDeliveryPage> => ({ schemaVersion: 1, manuscriptId: request.manuscriptId, items: [], nextCursor: null })),
  acknowledge: vi.fn(async () => undefined) }));
vi.mock("../../../../../../apps/web/src/core/services/agentGateway", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  agentSessionGateway: desktop, agentProposalGateway: desktop, agentWorkspaceReviewGateway: desktop,
  agentWritingFileDeliveryGateway: desktop, agentWorkspaceSuccessorGateway: {},
}));
vi.mock("../../../../../../apps/web/src/core/public/agentFileDelivery", () => ({ writingDeliveryToolGateway: { listen: async () => () => undefined, report: vi.fn() } }));
vi.mock("../../../../../../apps/web/src/core/public/agentSuccessorWorkspace", () => ({ writingSuccessorToolGateway: { listen: async () => () => undefined, report: vi.fn() } }));
vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({ notify: { warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
describe.each([false, true])("production delivery with injected gateways=%s", (injected) => {
const api = injected ? { create: vi.fn(), open: vi.fn(), readHistory: vi.fn(), waitForHistory: vi.fn(() => new Promise<never>(() => undefined)),
  latest: vi.fn(), publish: vi.fn(), review: vi.fn(), reviewBinding: vi.fn(), readFile: vi.fn(),
  list: vi.fn(async (request: { manuscriptId: string }): Promise<AgentWritingFileDeliveryPage> => ({ schemaVersion: 1, manuscriptId: request.manuscriptId, items: [], nextCursor: null })),
  acknowledge: vi.fn(async () => undefined) } : desktop;
const agentGateways = injected ? { sessions: api, proposals: api, reviews: api, deliveries: api } : undefined;
const events = raw.map(decodeAgentEvent), event = events[0]!;
const scope = { manuscriptId: "manuscript", conversationId: event.conversationId, requestId: event.requestId!, contextSnapshotId: "00000000-0000-0000-0000-000000000003" };
const admission = { scope, turnId: "00000000-0000-0000-0000-000000000002" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => {
  if (injected) for (const method of Object.values(desktop)) expect(method).not.toHaveBeenCalled();
  vi.clearAllMocks(); api.list.mockImplementation(async (request: { manuscriptId: string }) => ({ schemaVersion: 1, manuscriptId: request.manuscriptId, items: [], nextCursor: null }));
});

it("prepares unopened live text through production checkpoints and retains delivery across chat visibility and history selection", async () => {
  const files = new WritingFileSessions(), storage = new Map<string, WritingCheckpointRecord>();
  const checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(storage), vi.fn(), async (value) => hash(value));
  const disconnect = checkpoints.connect();
  const proposal: AgentProposalReview = { schemaVersion: 1, proposalId: "proposal", status: "pending", review: { schemaVersion: 1,
    binding: { scope, turnId: admission.turnId, leaseId: "lease", manifestHash: hash("manifest") }, changes: [{ path: "main.tex", kind: "modified", hasEditorBuffer: false,
      before: { sha256: hash("old"), byteSize: 3, executable: false }, after: { sha256: hash("agent"), byteSize: 5, executable: false } }] } };
  api.open.mockResolvedValue({ schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length });
  let finish!: (value: AgentHistoryResponse) => void;
  api.readHistory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  api.latest.mockResolvedValue(proposal);
  api.readFile.mockResolvedValue({ proposalId: "proposal", file: { before: { kind: "text", text: "old" }, after: { kind: "text", text: "agent" } } });
  const readFile = vi.fn(async () => ({ relativePath: parseManuscriptPath("main.tex"), content: "disk latest", sha256: hash("disk latest") }));
  const gateway = { readFile } as unknown as WritingGateway;
  const accept = vi.fn(async (operation: AgentApplicationScope) => {
    const file = files.get({ manuscriptId: scope.manuscriptId, relativePath: "main.tex" })!;
    expect(file.read().content).toBe("disk latest");
    await checkpoints.applyEditorAgent(file.identity, { operationId: operation.operationId, conversationId: scope.conversationId, requestId: scope.requestId },
      { operationId: operation.operationId, expected: file.applicationPort.read()!, text: "merged current" });
    return { kind: "state" as const, state: { kind: "state" as const, schemaVersion: 1 as const, scope: operation, status: "applied" as const, files: [] } };
  });
  let delivery!: ReturnType<typeof useWritingAgentFileDelivery>;
  function Host({ chat }: { chat: string }) {
    delivery = useWritingAgentFileDelivery({ manuscriptId: scope.manuscriptId, ready: true, files, checkpoints, gateway, accept, ...(agentGateways ? { agentGateways } : {}) });
    return <>{delivery.feedback}<span>{chat}</span></>;
  }
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container);
  try {
    await act(async () => root.render(<StrictMode><Host chat="conversation A" /></StrictMode>));
    await act(async () => { delivery.register(admission); });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => root.render(<StrictMode><Host chat="closed" /></StrictMode>));
    await act(async () => { finish({ schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length, afterSeq: 0, nextAfterSeq: null, events }); });
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
    expect(readFile).toHaveBeenCalledWith(scope.manuscriptId, "main.tex");
    const file = files.get({ manuscriptId: scope.manuscriptId, relativePath: "main.tex" })!;
    expect(file.read()).toMatchObject({ content: "merged current", reviewBaseline: "disk latest" });
    const state = file.state;
    await act(async () => root.render(<StrictMode><Host chat="conversation B" /></StrictMode>));
    await act(async () => root.render(<StrictMode><Host chat="historical conversation A" /></StrictMode>));
    expect(file.state).toBe(state);
    expect(accept).toHaveBeenCalledOnce(); expect(api.publish).not.toHaveBeenCalled();
    expect(undo({ state: file.state, dispatch: (transaction) => file.accept([transaction]) })).toBe(true);
    expect(file.read().content).toBe("disk latest");
    await checkpoints.flushAll();
    expect([...storage.values()][0]!.checkpoint.operations).toHaveLength(1);
  } finally { await act(async () => root.unmount()); container.remove(); disconnect(); }
});

it("discovers a durable completed turn without selecting its chat and acknowledges the application result", async () => {
  const files = new WritingFileSessions();
  const checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn(), async (value) => hash(value));
  const disconnect = checkpoints.connect();
  api.list.mockResolvedValueOnce({ schemaVersion: 1, manuscriptId: scope.manuscriptId, items: [{ id: 1, ...admission }], nextCursor: null });
  api.open.mockResolvedValue({ schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length });
  api.readHistory.mockResolvedValue({ schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length, afterSeq: 0, nextAfterSeq: null, events });
  api.latest.mockResolvedValue({ schemaVersion: 1, proposalId: "proposal", status: "pending", review: { schemaVersion: 1,
    binding: { scope, turnId: admission.turnId, leaseId: "lease", manifestHash: hash("manifest") }, changes: [] } });
  const gateway = { readFile: vi.fn() } as unknown as WritingGateway;
  const accept = vi.fn(async (operation: AgentApplicationScope) => ({ kind: "state" as const,
    state: { kind: "state" as const, schemaVersion: 1 as const, scope: operation, status: "applied" as const, files: [] } }));
  function Host() {
    const delivery = useWritingAgentFileDelivery({ manuscriptId: scope.manuscriptId, ready: true, files, checkpoints, gateway, accept, ...(agentGateways ? { agentGateways } : {}) });
    return <>{delivery.feedback}</>;
  }
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container);
  try {
    await act(async () => root.render(<Host />));
    await vi.waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith(admission));
    expect(api.list).toHaveBeenCalledWith({ manuscriptId: scope.manuscriptId, after: null, limit: 64 });
    expect(accept).toHaveBeenCalledOnce(); expect(gateway.readFile).not.toHaveBeenCalled();
    await act(async () => root.render(<Host />));
    expect(accept).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); disconnect(); }
});

it("keeps discovery failures visible and ignores a delayed page after switching manuscripts", async () => {
  const files = new WritingFileSessions(), checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn());
  const gateway = { readFile: vi.fn() } as unknown as WritingGateway, accept = vi.fn();
  let release!: (value: AgentWritingFileDeliveryPage) => void;
  api.list.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  api.list.mockRejectedValueOnce(new Error("database unavailable"));
  function Host({ manuscriptId }: { manuscriptId: string }) {
    const delivery = useWritingAgentFileDelivery({ manuscriptId, ready: true, files, checkpoints, gateway, accept, ...(agentGateways ? { agentGateways } : {}) });
    return <>{delivery.feedback}</>;
  }
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container);
  try {
    await act(async () => root.render(<Host manuscriptId={scope.manuscriptId} />));
    await act(async () => root.render(<Host manuscriptId="other" />));
    await vi.waitFor(() => expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining("读取失败"), expect.anything()));
    expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining("code=WRITING_DELIVERY_DISCOVERY_FAILED"), expect.anything());
    await act(async () => { release({ schemaVersion: 1, manuscriptId: scope.manuscriptId, items: [{ id: 1, ...admission }], nextCursor: null }); });
    expect(accept).not.toHaveBeenCalled(); expect(api.open).not.toHaveBeenCalled();
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    await vi.waitFor(() => expect(container.querySelector("button")).toBeNull());
  } finally { await act(async () => root.unmount()); container.remove(); }
});
it("holds a live retirement query during discovery and watching even after the delivery tail flushes", async () => {
  const files = new WritingFileSessions(), checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn());
  let finish!: (value: AgentWritingFileDeliveryPage) => void;
  const page = new Promise<AgentWritingFileDeliveryPage>(resolve => {finish = resolve;});
  api.list.mockReturnValueOnce(page).mockReturnValueOnce(page);
  api.open.mockResolvedValue({schemaVersion: 1, conversationId: scope.conversationId, watermark: 0});
  api.readHistory.mockResolvedValue({schemaVersion: 1, conversationId: scope.conversationId, watermark: 0, afterSeq: 0, nextAfterSeq: null, events: []});
  let delivery!: ReturnType<typeof useWritingAgentFileDelivery>;
  const gateway = {} as WritingGateway, accept = vi.fn();
  function Host() {
    delivery = useWritingAgentFileDelivery({manuscriptId: scope.manuscriptId, ready: true, files, checkpoints, gateway, accept,
      ...(agentGateways ? {agentGateways} : {})}); return null;
  }
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<StrictMode><Host /></StrictMode>));
    const query = delivery.hasPending;
    expect(delivery.entries).toEqual([]); expect(delivery.pending).toBe(false); expect(query()).toBe(true);
    await act(async () => finish({schemaVersion: 1, manuscriptId: scope.manuscriptId, items: [], nextCursor: null}));
    expect(query()).toBe(false);
    await act(async () => {delivery.register(admission); expect(query()).toBe(true);});
    await delivery.flush();
    expect(delivery.entries[0]?.status).toBe("watching"); expect(query()).toBe(true);
  } finally {await act(async () => root.unmount());}
});
it("keeps a published query attached to the live receiver when its file gateway owner changes", async () => {
  const files = new WritingFileSessions(), checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn());
  let delivery!: ReturnType<typeof useWritingAgentFileDelivery>;
  const first = {} as WritingGateway, second = {} as WritingGateway, accept = vi.fn();
  function Host({gateway}: {gateway: WritingGateway}) {
    delivery = useWritingAgentFileDelivery({manuscriptId: scope.manuscriptId, ready: true, files, checkpoints, gateway, accept,
      ...(agentGateways ? {agentGateways} : {})}); return null;
  }
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(<Host gateway={first} />));
    const query = delivery.hasPending, oldRegister = delivery.register; expect(query()).toBe(false);
    let finish!: (value: AgentWritingFileDeliveryPage) => void;
    api.list.mockReturnValueOnce(new Promise<AgentWritingFileDeliveryPage>(resolve => {finish = resolve;}));
    await act(async () => root.render(<Host gateway={second} />)); expect(query()).toBe(true);
    await act(async () => {oldRegister(admission); finish({schemaVersion: 1, manuscriptId: scope.manuscriptId, items: [], nextCursor: null});});
    expect(query()).toBe(false); expect(delivery.entries).toEqual([]); expect(accept).not.toHaveBeenCalled();
  } finally {await act(async () => root.unmount());}
});
it("retains live delivery ownership until the original asynchronous acknowledgement is confirmed", async () => {
  const files = new WritingFileSessions(), checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn());
  let reject!: (reason: Error) => void, confirm!: () => void;
  api.acknowledge.mockImplementationOnce(() => new Promise<undefined>((_resolve, fail) => {reject = fail;}))
    .mockImplementationOnce(() => new Promise<undefined>(resolve => {confirm = () => resolve(undefined);}));
  api.open.mockResolvedValue({schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length});
  api.readHistory.mockResolvedValue({schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length, afterSeq: 0, nextAfterSeq: null, events});
  api.latest.mockResolvedValue({schemaVersion: 1, proposalId: "proposal", status: "rejected", review: {schemaVersion: 1,
    binding: {scope, turnId: admission.turnId, leaseId: "lease", manifestHash: hash("manifest")}, changes: []}});
  let delivery!: ReturnType<typeof useWritingAgentFileDelivery>;
  const gateway = {} as WritingGateway, accept = vi.fn();
  function Host() {
    delivery = useWritingAgentFileDelivery({manuscriptId: scope.manuscriptId, ready: true, files, checkpoints, gateway, accept,
      ...(agentGateways ? {agentGateways} : {})}); return <>{delivery.feedback}</>;
  }
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container);
  try {
    await act(async () => root.render(<Host />));
    const query = delivery.hasPending;
    await act(async () => {delivery.register(admission); expect(query()).toBe(true);});
    await vi.waitFor(() => expect(api.acknowledge).toHaveBeenCalledOnce()); expect(query()).toBe(true);
    await act(async () => reject(new Error("lost acknowledgement")));
    await delivery.flush(); expect(query()).toBe(true);
    expect(delivery.entries[0]?.failureStage).toBe("acknowledgement");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expect(api.acknowledge).toHaveBeenCalledTimes(2)); expect(query()).toBe(true);
    await act(async () => confirm()); expect(query()).toBe(false);
    expect(api.acknowledge.mock.calls).toEqual([[admission], [admission]]); expect(accept).not.toHaveBeenCalled();
  } finally {await act(async () => root.unmount()); container.remove();}
});
it("shows the failed delivery stage and lets the user reconcile it without raw error content", async () => {
  const files = new WritingFileSessions(), checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn());
  const gateway = {} as WritingGateway, accept = vi.fn();
  api.list.mockResolvedValueOnce({ schemaVersion: 1, manuscriptId: scope.manuscriptId, items: [{ id: 1, ...admission }], nextCursor: null });
  api.open.mockResolvedValue({ schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length });
  api.readHistory.mockResolvedValue({ schemaVersion: 1, conversationId: scope.conversationId, watermark: events.length, afterSeq: 0, nextAfterSeq: null, events });
  api.latest.mockRejectedValueOnce(new Error("private request content"));
  function Host() {
    const delivery = useWritingAgentFileDelivery({ manuscriptId: scope.manuscriptId, ready: true, files, checkpoints,
      gateway, accept, ...(agentGateways ? { agentGateways } : {}) });
    return <>{delivery.feedback}</>;
  }
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container);
  try {
    await act(async () => root.render(<Host />));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="处理 Agent 文件修改"]')).not.toBeNull());
    expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining("接收文件修改尚未确认"), expect.anything());
    expect(notify.warning).not.toHaveBeenCalledWith(expect.stringContaining("private request content"), expect.anything());
    expect(container.textContent).not.toContain("private request content");
    expect(container.querySelector("button")?.textContent).toBe("重新核对");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
});

it.each(["delivery", "successor"] as const)("separates %s listener failure from an empty discovery result and reconnects", async kind => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const files = new WritingFileSessions(), checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn());
  const list = vi.fn(async () => ({schemaVersion: 1 as const, manuscriptId: "project", items: [], nextCursor: null}));
  const listen = vi.fn(async () => () => undefined);
  listen.mockRejectedValueOnce(Object.assign(new Error("private request content"), {code: "EVENT_CONNECTION_FAILED"}));
  const gateways: WritingAgentFileDeliveryGateways = {sessions: desktop, proposals: desktop, reviews: desktop, deliveries: {list, acknowledge: async () => undefined},
    ...(kind === "delivery" ? {tools: {listen, report: async () => undefined}} : {successorTools: {listen, report: async () => undefined}, successorWorkspaces: {} as NonNullable<WritingAgentFileDeliveryGateways["successorWorkspaces"]>})};
  let delivery!: ReturnType<typeof useWritingAgentFileDelivery>;
  const fileGateway = {} as WritingGateway, accept = vi.fn();
  function Host() {
    delivery = useWritingAgentFileDelivery({manuscriptId: "project", ready: true, files, checkpoints,
      gateway: fileGateway, accept, agentGateways: gateways});
    return <>{delivery.feedback}</>;
  }
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container);
  try {
    await act(async () => root.render(<Host />));
    expect(list).toHaveBeenCalled(); expect(delivery.pending).toBe(true); expect(delivery.hasPending()).toBe(true);
    expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining("监听失败"), expect.anything());
    expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining("causeCode=EVENT_CONNECTION_FAILED"), expect.anything());
    expect(notify.warning).not.toHaveBeenCalledWith(expect.stringContaining("记录读取失败"), expect.anything());
    expect(notify.warning).not.toHaveBeenCalledWith(expect.stringContaining("private request content"), expect.anything());
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(listen).toHaveBeenCalledTimes(2); expect(delivery.pending).toBe(false); expect(delivery.hasPending()).toBe(false);
    expect(container.querySelector("button")).toBeNull();
  } finally {await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals();}
});

it("ignores a late subscription failure after switching projects and disconnects the current listener", async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const files = new WritingFileSessions(), checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(new Map()), vi.fn());
  let rejectOld!: (reason: Error) => void;
  const disconnect = vi.fn(), listen = vi.fn(async () => disconnect);
  listen.mockImplementationOnce(() => new Promise((_, reject) => {rejectOld = reject;}));
  const gateways: WritingAgentFileDeliveryGateways = {sessions: desktop, proposals: desktop, reviews: desktop,
    deliveries: {list: async request => ({schemaVersion: 1, manuscriptId: request.manuscriptId, items: [], nextCursor: null}), acknowledge: async () => undefined},
    tools: {listen, report: async () => undefined}};
  const fileGateway = {} as WritingGateway, accept = vi.fn();
  function Host({id}: {id: string}) {return useWritingAgentFileDelivery({manuscriptId: id, ready: true, files, checkpoints,
    gateway: fileGateway, accept, agentGateways: gateways}).feedback;}
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container);
  try {
    await act(async () => root.render(<Host id="old" />));
    await act(async () => root.render(<Host id="new" />));
    await act(async () => rejectOld(new Error("Old subscription failed")));
    expect(notify.warning).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
  } finally {await act(async () => root.unmount()); expect(disconnect).toHaveBeenCalledOnce(); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals();}
});
