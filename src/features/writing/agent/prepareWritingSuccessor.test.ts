/** @vitest-environment happy-dom */
import { expect, it, vi } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import type { AgentWorkspaceSuccessorPrepare } from "@research-assistant/data/agent";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { prepareWritingSuccessor } from "./prepareWritingSuccessor";

it.each([false, true])("only reports the prepared lease if live buffers stay unchanged (edited: %s)", async edited => {
  const scope = { manuscriptId: "m", conversationId: "c", requestId: "r", contextSnapshotId: "s" };
  const request = { requestId: "event", scope, turnId: "turn", generation: 1, predecessorDeliveryId: "delivery", leaseId: "lease" };
  const confirmation = { scope, turnId: "turn", leaseId: "lease", manifestHash: "a".repeat(64) };
  const files = new WritingFileSessions();
  const file = files.open({ manuscriptId: "m", relativePath: "main.tex" }, "original", "sha");
  const gateway = { readFile: async () => ({ relativePath: parseManuscriptPath("main.tex"), content: "original", sha256: "sha" }) };
  const report = vi.fn().mockResolvedValue(undefined);
  const prepare = vi.fn(async (_request: AgentWorkspaceSuccessorPrepare) => {
    if (edited) file.dispatch({ changes: { from: 0, insert: "typed " } });
    return confirmation;
  });
  await prepareWritingSuccessor(request, { current: () => ({ manuscriptId: "m", ready: true, files, gateway }),
    workspaces: { prepare, recover: vi.fn() }, tools: { listen: vi.fn(), report } });
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({ generation: 1, buffers: [{ path: "main.tex", text: "original" }] });
  expect(report).toHaveBeenCalledWith({ request, confirmation: edited ? null : confirmation });
});

it("keeps the pending review baseline and later human edit when a successor capture becomes stale", async () => {
  const scope = { manuscriptId: "m", conversationId: "c", requestId: "r", contextSnapshotId: "s" };
  const request = { requestId: "event", scope, turnId: "turn", generation: 1, predecessorDeliveryId: "delivery", leaseId: "lease" };
  const confirmation = { scope, turnId: "turn", leaseId: "lease", manifestHash: "a".repeat(64) };
  const initial = "标题\n\n数值 80%", first = "标题\n\n数值 85%", human = "我的标题\n\n数值 91%";
  const files = new WritingFileSessions();
  const file = files.open({ manuscriptId: "m", relativePath: "main.tex" }, initial, "disk-sha");
  expect(file.applyAgent("first-delivery", file.read().version, first)).toBe("applied");
  const gateway = { readFile: async () => ({ relativePath: parseManuscriptPath("main.tex"), content: first, sha256: "disk-sha" }) };
  const report = vi.fn().mockResolvedValue(undefined);
  const prepare = vi.fn(async (_request: AgentWorkspaceSuccessorPrepare) => {
    file.dispatch({ changes: { from: 0, to: 2, insert: "我的标题" }, userEvent: "input.type" });
    const offset = file.state.doc.toString().indexOf("85%");
    file.dispatch({ changes: { from: offset, to: offset + 3, insert: "91%" }, userEvent: "input.type" });
    return confirmation;
  });
  await prepareWritingSuccessor(request, { current: () => ({ manuscriptId: "m", ready: true, files, gateway }),
    workspaces: { prepare, recover: vi.fn() }, tools: { listen: vi.fn(), report } });
  expect(prepare.mock.calls[0]?.[0].buffers[0]?.text).toBe(first);
  expect(file.read()).toMatchObject({ content: human, reviewBaseline: "我的标题\n\n数值 80%" });
  expect(report).toHaveBeenCalledWith({ request, confirmation: null });
});
