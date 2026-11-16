/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WritingWorkspaceChangeSummary } from "@research-assistant/writing-projects-preview/writing-workspace-review";
import { WritingFileSessions } from "@research-assistant/writing-projects-preview/writing-file-sessions";
import { redo, undo } from "@codemirror/commands";

const gateway = vi.hoisted(() => ({ review: vi.fn(), readFile: vi.fn(), list: vi.fn(), error: vi.fn(), latest: vi.fn(), publish: vi.fn(), reject: vi.fn(), success: vi.fn(), find: vi.fn(), open: vi.fn(), execute: vi.fn() }));
vi.mock("@research-assistant/workbench-preview/source-navigation", () => ({ openSourceLink: gateway.open }));
vi.mock("@research-assistant/workbench-preview/agent-gateway", () => ({ agentWorkspaceReviewGateway: gateway, agentProposalGateway: gateway, agentApplicationGateway: gateway }));
vi.mock("@research-assistant/workbench-preview/notifications", () => ({ notify: { error: gateway.error, success: gateway.success } }));

const id = "11111111-1111-4111-8111-111111111111";
const scope = { conversationId: id, manuscriptId: id, requestId: id, contextSnapshotId: id };
const binding = { scope, turnId: id, leaseId: id, manifestHash: "a".repeat(64) };
const version = { sha256: "b".repeat(64), byteSize: 3, executable: false };
const first = { path: "main.tex", kind: "modified" as const, before: version, after: { ...version, sha256: "c".repeat(64) }, hasEditorBuffer: true };
const second = { ...first, path: "next.tex" };
const inventory = { schemaVersion: 1 as const, binding, changes: [first, second] };
const file = { schemaVersion: 1 as const, binding, change: first, before: { kind: "text" as const, text: "Old" }, after: { kind: "text" as const, text: "New" } };

it("restores a confirmed card by durable identity while delivery recovery remains pending", async () => {
  gateway.latest.mockResolvedValue(null);
  gateway.review.mockImplementation(async request => {
    if (!request.proposalId) throw new Error("execution copy unavailable");
    return {schemaVersion:1,proposalId:id,status:"applied",review:inventory};
  });
  gateway.readFile.mockResolvedValue({schemaVersion:1,proposalId:id,file});
  const delivery = {scope,turnId:id,status:"waiting" as const,failureStage:null};
  const undoProposal = vi.fn();
  const render = () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false}
    publishedProposalId={id} delivery={delivery} undoProposal={undoProposal}/>);
  await act(async () => render());
  expect(container.textContent).toContain("Edited 2 files");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Undo"]')?.disabled).toBe(true);
  await act(async () => root.render(null));
  await act(async () => render());
  expect(container.textContent).toContain("Edited 2 files");
  expect(gateway.latest).not.toHaveBeenCalled();
  expect(undoProposal).not.toHaveBeenCalled();
  expect(gateway.publish).not.toHaveBeenCalled();
});

it("rejects a restored change identity from a different submission", async () => {
  gateway.review.mockResolvedValue({schemaVersion:1,proposalId:id,status:"applied",
    review:{...inventory,binding:{...binding,scope:{...scope,requestId:"other-request"}}}});
  const report = vi.fn();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false}
    publishedProposalId={id} onReadErrorChange={report}/>));
  expect(container.querySelector(".writing-agent-inline-diff-card")).toBeNull();
  expect(report.mock.calls.at(-1)?.[0]?.message).toContain("WORKSPACE_REVIEW_UNAVAILABLE");
  expect(gateway.readFile).not.toHaveBeenCalled();
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  gateway.latest.mockResolvedValue(null);
  gateway.review.mockResolvedValue(inventory);
  gateway.readFile.mockResolvedValue(file);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});


it("reads file changes silently and shows only a confirmed nonempty summary", async () => {
  let resolve!: (value: typeof inventory) => void;
  gateway.review.mockReturnValue(new Promise<typeof inventory>(done => { resolve = done; }));
  const availability = vi.fn();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} onAvailablePathsChange={availability} />));
  expect(container.textContent).not.toContain("正在读取文件变更");
  expect(container.textContent).not.toContain("查看 diff");
  expect(container.querySelector(".writing-agent-inline-diff")).toBeNull();
  await act(async () => resolve(inventory));
  expect(container.textContent).toContain("Edited 2 files");
  expect(availability).toHaveBeenLastCalledWith(["main.tex", "next.tex"]);
});

it("keeps an empty result silent and reports failed reads to the conversation for retry", async () => {
  gateway.review.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({...inventory, changes: []});
  const report = vi.fn();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} onReadErrorChange={report} />));
  expect(container.textContent).not.toContain("无法读取文件变更");
  expect(container.querySelector(".writing-agent-inline-diff")).toBeNull();
  expect(gateway.error).not.toHaveBeenCalled();
  const failure = report.mock.calls.at(-1)?.[0] as {message: string; retry: () => void};
  expect(failure.message).toContain("WORKSPACE_REVIEW_UNAVAILABLE");
  await act(async () => failure.retry());
  expect(gateway.review).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith(null);
  expect(container.querySelector(".writing-agent-inline-diff")).toBeNull();
});

it("does not display or report the old scope while a different scope is loading", async () => {
  const nextScope = {...scope, requestId: "22222222-2222-4222-8222-222222222222"};
  let resolve!: (value: typeof inventory) => void;
  const availability = vi.fn();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} onAvailablePathsChange={availability} />));
  expect(container.textContent).toContain("Edited 2 files");
  gateway.review.mockReturnValueOnce(new Promise<typeof inventory>(done => {resolve = done;}));
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={nextScope} disabled={false} onAvailablePathsChange={availability} />));
  expect(container.querySelector(".writing-agent-inline-diff")).toBeNull();
  expect(availability).toHaveBeenLastCalledWith([]);
  await act(async () => resolve({...inventory, binding: {...binding, scope: nextScope}, changes: []}));
  expect(container.querySelector(".writing-agent-inline-diff")).toBeNull();
  expect(availability).toHaveBeenLastCalledWith([]);
});

it("does not report a late read failure to a different conversation scope", async () => {
  let reject!: (reason: Error) => void;
  gateway.review.mockReturnValueOnce(new Promise<typeof inventory>((_, fail) => {reject = fail;}));
  const oldReport = vi.fn(), nextReport = vi.fn();
  const nextScope = {...scope, requestId: "22222222-2222-4222-8222-222222222222"};
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} onReadErrorChange={oldReport} />));
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={nextScope} disabled={false} onReadErrorChange={nextReport} />));
  await act(async () => reject(new Error("late failure")));
  expect(oldReport.mock.calls.every(([error]) => error === null)).toBe(true);
  expect(nextReport.mock.calls.every(([error]) => error === null)).toBe(true);
  expect(gateway.error).not.toHaveBeenCalled();
});

it("opens a file row without a redundant View changes button in the production change summary", async () => {
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} />));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.textContent).not.toContain("View changes");
  const fileButton = container.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-list button");
  expect(fileButton?.textContent).toContain("main.tex");
  await act(async () => fileButton!.click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector("dialog")).toBeNull();
  expect(gateway.readFile).toHaveBeenCalledTimes(2); // Stats only; clicking does not read a historical comparison.
});

it("keeps frozen file rows readable while file mutations are disabled", async () => {
  gateway.latest.mockResolvedValue({ schemaVersion: 1, proposalId: id, status: "accepted", review: inventory });
  gateway.readFile.mockResolvedValue({ schemaVersion: 1, proposalId: id, file });
  const undoProposal = vi.fn();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled undoProposal={undoProposal} />));
  const rows = [...container.querySelectorAll<HTMLButtonElement>(".writing-agent-inline-diff-list button")];
  expect(rows).toHaveLength(2);
  expect(rows.every(row => !row.disabled)).toBe(true);
  const undoButton = container.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-undo")!;
  expect(undoButton.disabled).toBe(true);
  await act(async () => { undoButton.click(); rows[0]!.click(); });
  expect(undoProposal).not.toHaveBeenCalled();
  expect(container.querySelector("dialog")).toBeNull();
  expect(gateway.readFile).toHaveBeenCalledTimes(2);
  expect(gateway.publish).not.toHaveBeenCalled(); expect(gateway.execute).not.toHaveBeenCalled();
});

it("disables an older batch Undo after later edits to its files, without changing frozen history", async () => {
  const sessions = new WritingFileSessions();
  const changed = sessions.open({ manuscriptId: id, relativePath: first.path }, "Old");
  changed.applyAgent("first", 0, "New");
  sessions.open({ manuscriptId: id, relativePath: second.path }, "New");
  gateway.latest.mockResolvedValue({ schemaVersion: 1, proposalId: id, status: "accepted", review: inventory });
  gateway.readFile.mockResolvedValue({ schemaVersion: 1, proposalId: id, file });
  const undoProposal = vi.fn();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} fileSessions={sessions} undoProposal={undoProposal} />));
  const button = container.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-undo")!;
  expect(button.disabled).toBe(false);
  await act(async () => { changed.resolveAll("keep"); });
  expect(button.disabled).toBe(false); // Keep changes B, not D.
  await act(async () => {
    changed.applyAgent("later-chat", changed.read().version, "New\nlater change", {
      operationId: "later-chat", conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), resultSha256: "e".repeat(64),
    });
  });
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-description")).toContain("后续修改");
  await act(async () => button.click());
  expect(undoProposal).not.toHaveBeenCalled();
  expect(container.querySelector(".writing-agent-inline-diff-counts")?.textContent).toBe("+2 −2");
  const row = container.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-list button")!;
  expect(row.disabled).toBe(false);
  await act(async () => row.click());
  expect(container.querySelector("dialog")).toBeNull();
  await act(async () => { undo({ state: changed.state, dispatch: transaction => changed.accept([transaction]) }); });
  expect(button.disabled).toBe(false);
  expect(gateway.latest).toHaveBeenCalledTimes(1); // Direct navigation does not reload historical state.
});

it.each(["files", "application", "acknowledgement"] as const)("does not label an incomplete %s delivery as Edited", async failureStage => {
  gateway.latest.mockResolvedValue({ schemaVersion: 1, proposalId: id, status: "accepted", review: inventory });
  gateway.readFile.mockResolvedValue({ schemaVersion: 1, proposalId: id, file });
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} undoProposal={vi.fn()}
    delivery={{ scope, turnId: id, status: "error", failureStage,
      ...(failureStage === "application" ? { application: { kind: "state", schemaVersion: 1, scope: { ...scope, proposalId: id, operationId: id }, status: "applied", files: [] } } : {}) }} />));
  expect(container.querySelector('[aria-label="消息中的文件改动"]')).toBeNull();
  expect(container.querySelector(".writing-agent-inline-diff-undo")).toBeNull();
  expect(container.textContent).not.toMatch(/Edited|文件修改待保存|文件修改未完成|交付记录待确认/);
  expect(gateway.latest).not.toHaveBeenCalled();
});

it("derives changed line counts when production data omits preview stats", async () => {
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} />));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(container.textContent).toContain("+2");
  expect(container.textContent).toContain("−2");
});

it("counts created and deleted textual history without preview-specific statistics", async () => {
  const created = { ...first, path: "created.tex", kind: "created", before: null };
  const deleted = { ...second, path: "deleted.tex", kind: "deleted", after: null };
  gateway.review.mockResolvedValue({ ...inventory, changes: [created, deleted] });
  gateway.readFile.mockImplementation(async (request) => ({ ...file, change: request.path === created.path ? created : deleted,
    before: request.path === created.path ? null : { kind: "text", text: "one\ntwo\n" },
    after: request.path === deleted.path ? null : { kind: "text", text: "new one\nnew two\nnew three\n" } }));
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} />));
  expect(container.querySelector(".writing-agent-inline-diff-counts")?.textContent).toBe("+3 −2");
  expect(gateway.publish).not.toHaveBeenCalled();
});

it("reads an unsaved candidate without publishing, rejecting or applying it", async () => {
  const proposal = { schemaVersion: 1 as const, proposalId: id, status: "pending" as const, review: inventory };
  gateway.publish.mockResolvedValueOnce(proposal);
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} />));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(gateway.publish).not.toHaveBeenCalled();
  expect(gateway.reject).not.toHaveBeenCalled(); expect(gateway.execute).not.toHaveBeenCalled();
  expect(container.querySelector(".writing-agent-inline-diff-undo")).toBeNull();
  expect(container.querySelector(".writing-workspace-review")).toBeNull();
});

it("restores a durable proposal after the view is recreated without applying it", async () => {
  const proposal = { schemaVersion: 1 as const, proposalId: id, status: "pending" as const, review: inventory };
  gateway.latest.mockResolvedValue(proposal);
  gateway.readFile.mockResolvedValue({ schemaVersion: 1, proposalId: id, file });
  const render = () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} />);
  await act(async () => render());
  await act(async () => root.render(null));
  await act(async () => render());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(gateway.review).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Edited 2 files");
  expect(container.textContent).toContain("+2");
  expect(gateway.readFile).toHaveBeenCalledWith({ proposal: { conversationId: id, manuscriptId: id, proposalId: id }, path: "main.tex" });
  expect(gateway.publish).not.toHaveBeenCalled();
});

it("keeps frozen per-file and total statistics through edits, Keep, history commands and remounts", async () => {
  const sessions = new WritingFileSessions();
  for (const change of inventory.changes) {
    const file = sessions.open({ manuscriptId: id, relativePath: change.path }, "current baseline");
    file.applyAgent(`operation-${change.path}`, 0, "current proposal\nsecond line");
  }
  const render = () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} fileSessions={sessions} />);
  await act(async () => render());
  const expectFrozenStatistics = (): void => {
    expect(container.querySelector(".writing-agent-inline-diff-counts")?.textContent).toBe("+2 −2");
    expect([...container.querySelectorAll(".writing-agent-inline-diff-list small")].map(element => element.textContent))
      .toEqual(["+1 −1", "+1 −1"]);
  };
  expectFrozenStatistics();
  const firstFile = sessions.get({ manuscriptId: id, relativePath: first.path })!;
  await act(async () => { for (const file of sessions.forManuscript(id)) file.resolveAll("keep"); });
  expectFrozenStatistics();
  const state = firstFile.state;
  await act(async () => root.render(null));
  await act(async () => render());
  expect(firstFile.state).toBe(state);
  expect(firstFile.read()).toMatchObject({ content: "current proposal\nsecond line", reviewBaseline: "current proposal\nsecond line" });
  await act(async () => { undo({ state: firstFile.state, dispatch: (tr) => firstFile.accept([tr]) }); });
  expect(firstFile.pending).toBe(true);
  expectFrozenStatistics();
  await act(async () => { redo({ state: firstFile.state, dispatch: tr => firstFile.accept([tr]) }); });
  expect(firstFile.pending).toBe(false);
  expectFrozenStatistics();
  await act(async () => { firstFile.dispatch({ changes: { from: 0, insert: "user edit\n" } }); });
  expectFrozenStatistics();
  await act(async () => {
    expect(firstFile.applyAgent("later-operation", firstFile.read().version, "another conversation's change\nthird\nfourth", {
      operationId: "later-operation", conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), resultSha256: "d".repeat(64),
    })).toBe("applied");
  });
  expectFrozenStatistics();
  await act(async () => container.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-list button")!.click());
  expect(container.querySelector("dialog")).toBeNull();
  expect(firstFile.read().content).toBe("another conversation's change\nthird\nfourth");
  expect(gateway.publish).not.toHaveBeenCalled(); expect(gateway.reject).not.toHaveBeenCalled(); expect(gateway.execute).not.toHaveBeenCalled();
});

it.each(["pending", "accepted", "recovery_required", "undone"])("retains the file-owned Undo entry for %s history without the legacy panel", async (status) => {
  gateway.latest.mockResolvedValue({ schemaVersion: 1, proposalId: id, status, review: inventory });
  gateway.readFile.mockResolvedValue({ schemaVersion: 1, proposalId: id, file });
  let finish!: (value: { kind: "busy" }) => void;
  const undoProposal = vi.fn(() => new Promise<{ kind: "busy" }>(resolve => { finish = resolve; }));
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} undoProposal={undoProposal} />));
  const header = container.querySelector(".writing-agent-inline-diff-header")!;
  const button = header.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-undo")!;
  expect(button.textContent).toBe("Undo");
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).not.toMatch(/应用与恢复记录|刷新应用状态|撤销已接受修改/);
  await act(async () => { button.click(); button.click(); });
  expect(undoProposal).toHaveBeenCalledExactlyOnceWith({ manuscriptId: id, conversationId: id, proposalId: id });
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("Undo…");
  await act(async () => finish({ kind: "busy" }));
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe("Undo");
  expect(gateway.execute).not.toHaveBeenCalled();
});
it("preserves frozen statistics when a restored file session becomes available", async () => {
  const sessions = new WritingFileSessions();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} fileSessions={sessions} />));
  expect(container.querySelector(".writing-agent-inline-diff-counts")?.textContent).toBe("+2 −2");
  await act(async () => { sessions.open({ manuscriptId: id, relativePath: first.path }, "already kept text"); });
  expect(container.querySelector(".writing-agent-inline-diff-counts")?.textContent).toBe("+2 −2");
});
it("discovers a late published proposal only when this submission reaches the file", async () => {
  const sessions = new WritingFileSessions();
  const current = sessions.open({ manuscriptId: id, relativePath: first.path }, "Old");
  const undoProposal = vi.fn().mockResolvedValue({ kind: "busy" });
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} fileSessions={sessions} undoProposal={undoProposal} />));
  expect(container.querySelector("details")).toBeNull();
  expect(container.querySelector(".writing-agent-inline-diff-undo")).toBeNull();
  expect(gateway.latest).toHaveBeenCalledTimes(1);
  gateway.latest.mockResolvedValue({ schemaVersion: 1, proposalId: id, status: "recovery_required", review: inventory });
  gateway.readFile.mockResolvedValue({ schemaVersion: 1, proposalId: id, file });
  await act(async () => { current.applyAgent("delivery", 0, "New", {
    operationId: "delivery", conversationId: id, requestId: id, resultSha256: "c".repeat(64),
  }); });
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).toContain("Edited 2 files");
  expect(gateway.latest).toHaveBeenCalledTimes(2);
  const undoButton = container.querySelector<HTMLButtonElement>(".writing-agent-inline-diff-undo");
  expect(undoButton?.textContent).toBe("Undo");
  await act(async () => undoButton!.click());
  expect(undoProposal).toHaveBeenCalledExactlyOnceWith({ manuscriptId: id, conversationId: id, proposalId: id });
  expect(container.querySelector("details")).toBeNull();
  await act(async () => {
    current.dispatch({ changes: { from: 0, insert: "user input " } });
    current.dispatch({ selection: { anchor: 2 } });
    current.resolveAll("keep");
    undo({ state: current.state, dispatch: transaction => current.accept([transaction]) });
    const other = sessions.open({ manuscriptId: id, relativePath: second.path }, "Old");
    other.applyAgent("another-conversation", 0, "New", { operationId: "another-conversation",
      conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), resultSha256: "c".repeat(64) });
  });
  expect(gateway.latest).toHaveBeenCalledTimes(2);
  expect(gateway.publish).not.toHaveBeenCalled(); expect(gateway.execute).not.toHaveBeenCalled();
});

it.each([1, 2])("opens %i changed files directly without fetching comparison content on click", async count => {
  gateway.review.mockResolvedValue({...inventory, changes:inventory.changes.slice(0,count)});
  const jump = vi.fn();
  await act(async () => root.render(<WritingWorkspaceChangeSummary scope={scope} disabled={false} onJumpToEditor={jump}/>));
  const reads = gateway.readFile.mock.calls.length;
  const entries = count===1 ? container.querySelectorAll<HTMLButtonElement>(".agent-change-summary-file") : container.querySelectorAll<HTMLButtonElement>(".writing-agent-inline-diff-list button");
  await act(async () => entries[count-1]!.click());
  expect(jump).toHaveBeenCalledExactlyOnceWith(inventory.changes[count-1]!.path);
  expect(gateway.readFile).toHaveBeenCalledTimes(reads);
  expect(container.querySelector("dialog, .writing-text-diff")).toBeNull();
  expect(container.textContent).not.toContain("Old");
});
