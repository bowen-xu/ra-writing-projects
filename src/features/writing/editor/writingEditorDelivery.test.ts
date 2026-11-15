/** @vitest-environment happy-dom */
import { createHash } from "node:crypto";
import { undo } from "@codemirror/commands";
import { expect, it, vi } from "vitest";
import type { AgentApplicationRequest, AgentApplicationState, AgentProposalReview } from "@research-assistant/core/agent";
import type { WritingCheckpointRecord } from "@research-assistant/writing";
import { parseManuscriptPath } from "@research-assistant/writing";
import { WritingCheckpointPersistence } from "../persistence/WritingCheckpointPersistence";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import { WritingFileSessions } from "./writingFileSessions";
import { createWritingEditorApplication } from "./editorApplication";
import { createWritingEditorDelivery, createWritingFileOperationDelivery } from "./writingEditorDelivery";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const scope = { manuscriptId: "manuscript", conversationId: "conversation", proposalId: "proposal", operationId: "operation" };
  const identity = { manuscriptId: scope.manuscriptId, relativePath: "main.tex" };
  const files = new WritingFileSessions(), storage = new Map<string, WritingCheckpointRecord>();
  const adapter = createMemoryWritingCheckpointGateway(storage), save = vi.fn(adapter.save);
  const checkpoints = new WritingCheckpointPersistence(files, { list: adapter.list, save }, vi.fn(), async (text) => hash(text));
  const disconnect = checkpoints.connect();
  const file = await checkpoints.open(scope.manuscriptId, { relativePath: parseManuscriptPath(identity.relativePath), content: "before", sha256: hash("before") });
  const original = file.applicationPort.read()!;
  let state: AgentApplicationState = { kind: "state", schemaVersion: 1, scope, status: "applying", files: [{ path: identity.relativePath,
    phase: "pending", target: { kind: "editor", sessionId: original.sessionId, revision: original.revision, resultRevision: null } }] };
  const confirmed = vi.fn();
  const execute = vi.fn(async (request: AgentApplicationRequest) => {
    if (request.action === "prepareEditor" && state.files[0]!.phase === "pending") {
      state = { ...state, files: [{ ...state.files[0]!, phase: "dispatched" }] };
      return { kind: "edit" as const, schemaVersion: 1 as const, scope, expected: request.current, text: "after" };
    }
    if (request.action === "confirmEditor") {
      confirmed([...storage.values()][0]?.checkpoint);
      state = { ...state, status: "applied", files: [{ ...state.files[0]!, phase: "acknowledged" }] };
    }
    if (request.action === "deferEditor") state = { ...state, status: "recoveryRequired" };
    return state;
  });
  const proposal: AgentProposalReview = { schemaVersion: 1, proposalId: scope.proposalId, status: "pending", review: { schemaVersion: 1,
    binding: { scope: { manuscriptId: scope.manuscriptId, conversationId: scope.conversationId, requestId: "request", contextSnapshotId: "context" },
      turnId: "turn", leaseId: "lease", manifestHash: hash("manifest") },
    changes: [{ path: identity.relativePath, kind: "modified", before: { sha256: hash("before"), byteSize: 6, executable: false },
      after: { sha256: hash("after"), byteSize: 5, executable: false }, hasEditorBuffer: true }] } };
  const review = vi.fn(async () => proposal);
  const delivery = createWritingEditorDelivery(files, checkpoints, { review });
  const apply = vi.spyOn(delivery, "apply"), settle = vi.spyOn(delivery, "settle");
  const app = createWritingEditorApplication({ execute }, () => file.applicationPort, delivery);
  return { scope, identity, file, files, checkpoints, storage, save, app, execute, confirmed, apply, settle, proposal, review, disconnect };
}

it("checkpoints native delivery provenance with D/B before confirming the actual editor receipt", async () => {
  const f = await fixture();
  try {
    const result = await f.app.apply(f.scope, f.identity.relativePath);
    expect(result.kind === "state" && result.state.status).toBe("applied");
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.confirmed).toHaveBeenCalledWith(expect.objectContaining({ content: "after", reviewBaseline: "before", operations: [
      { operationId: "operation", conversationId: "conversation", requestId: "request", resultSha256: hash("after") },
    ] }));
    expect(undo({ state: f.file.state, dispatch: (transaction) => f.file.accept([transaction]) })).toBe(true);
    await f.checkpoints.flushAll();
    expect(f.file.read()).toMatchObject({ content: "before", reviewBaseline: "before" });
    expect([...f.storage.values()][0]!.checkpoint.operations).toHaveLength(1);
  } finally { f.disconnect(); }
});

it("preserves the original review baseline across two separately identified editor deliveries", async () => {
  const identity = { manuscriptId: "manuscript", relativePath: "main.tex" };
  const files = new WritingFileSessions(), storage = new Map<string, WritingCheckpointRecord>();
  const checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(storage), vi.fn(), async text => hash(text));
  const disconnect = checkpoints.connect();
  try {
    const file = await checkpoints.open(identity.manuscriptId, { relativePath: parseManuscriptPath(identity.relativePath),
      content: "Frozen manuscript", sha256: hash("Frozen manuscript") });
    for (const [operationId, text] of [["first", "modified"], ["second", "modified twice"]] as const) {
      const result = await checkpoints.applyEditorAgent(identity, { operationId, conversationId: "conversation", requestId: "request" },
        { operationId, expected: file.applicationPort.read()!, text });
      expect(result.status).toBe("applied");
      expect(await checkpoints.settleEditorAgent(identity, { operationId, conversationId: "conversation", requestId: "request" })).toBe(true);
    }
    expect(file.read()).toMatchObject({ content: "modified twice", reviewBaseline: "Frozen manuscript" });
    const checkpoint = [...storage.values()][0]!.checkpoint;
    expect(checkpoint.operations.map(operation => operation.operationId)).toEqual(["first", "second"]);
    expect(checkpoint.editorReceipt).toMatchObject({ operationId: "second", text: "modified twice" });
  } finally { disconnect(); }
});

it("keeps a saved human edit and its original baseline when a later disk version conflicts", async () => {
  const identity = { manuscriptId: "manuscript", relativePath: "main.tex" };
  const files = new WritingFileSessions(), storage = new Map<string, WritingCheckpointRecord>();
  const checkpoints = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(storage), vi.fn(), async text => hash(text));
  const disconnect = checkpoints.connect();
  try {
    // Same text and saved-candidate order as the HBS reference savedCandidate regression.
    const initial = "研究计划\n\n研究问题：局部观察如何支持逻辑推理？\n\n实验设置\n样本量为 120。\n模型准确率为 80%。\n\n评估方法\n重复实验 3 次。\n记录每次实验的误差。\n比较不同场景的表现。\n保留原始观察记录。\n\n下一步：补充复杂场景的验证。";
    const first = initial.replace("80%", "85%"), human = first.replace("85%", "91%"), incoming = human.replace("91%", "90%");
    const file = await checkpoints.open(identity.manuscriptId, { relativePath: parseManuscriptPath(identity.relativePath),
      content: initial, sha256: hash(initial) });
    const operation = { operationId: "first", conversationId: "conversation", requestId: "request" };
    expect((await checkpoints.applyEditorAgent(identity, operation,
      { operationId: operation.operationId, expected: file.applicationPort.read()!, text: first })).status).toBe("applied");
    const firstSave = await checkpoints.beginSave(file.read(), hash(initial));
    await checkpoints.completeSave(identity, firstSave, hash(first));
    const position = file.state.doc.toString().indexOf("85%");
    file.dispatch({ changes: { from: position, to: position + 3, insert: "91%" }, userEvent: "input.type" });
    const humanSave = await checkpoints.beginSave(file.read(), hash(first));
    await checkpoints.completeSave(identity, humanSave, hash(human));
    expect(() => file.observeDisk(incoming, hash(incoming))).toThrow("文件已被外部修改");
    expect(file.read()).toMatchObject({ content: human, reviewBaseline: initial });
    expect([...storage.values()][0]!.checkpoint).toMatchObject({ content: human, reviewBaseline: initial, savedSha256: hash(human) });
  } finally { disconnect(); }
});

it("defers after checkpoint failure, then reconciles the same receipt without overwriting later input", async () => {
  const f = await fixture(), saved = f.save.getMockImplementation()!;
  try {
    f.save.mockImplementation(async () => { throw new Error("checkpoint unavailable"); });
    expect((await f.app.apply(f.scope, f.identity.relativePath)).kind).toBe("unconfirmed");
    expect(f.confirmed).not.toHaveBeenCalled();
    expect(f.file.read().content).toBe("after");
    f.file.resolveAll("keep");
    f.file.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" });
    f.save.mockImplementation(saved);
    const result = await f.app.recover(f.scope, f.identity.relativePath);
    expect(result.kind === "state" && result.state.status).toBe("applied");
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.file.read()).toMatchObject({ content: "manual after", reviewBaseline: "manual after" });
    expect(f.confirmed).toHaveBeenCalledWith(expect.objectContaining({ content: "manual after", operations: expect.any(Array) }));
  } finally { f.disconnect(); }
});

it("does not confirm a readable receipt if its reliable checkpoint settlement fails", async () => {
  const f = await fixture();
  try {
    f.settle.mockRejectedValue(new Error("lost checkpoint"));
    expect((await f.app.apply(f.scope, f.identity.relativePath)).kind).toBe("unconfirmed");
    expect(f.file.applicationPort.readReceipt(f.scope.operationId)).not.toBeNull();
    expect(f.confirmed).not.toHaveBeenCalled();
  } finally { f.disconnect(); }
});

it.each(["manuscript", "conversation", "proposal", "path", "request"])("rejects mismatched immutable proposal provenance before native dispatch (%s)", async (field) => {
  const f = await fixture();
  try {
    const proposal = structuredClone(f.proposal);
    f.review.mockResolvedValue({ ...proposal, ...(field === "proposal" ? { proposalId: "other" } : {}), review: {
      ...proposal.review, binding: { ...proposal.review.binding, scope: { ...proposal.review.binding.scope,
        ...(field === "manuscript" ? { manuscriptId: "other" } : field === "conversation" ? { conversationId: "other" } : field === "request" ? { requestId: "" } : {}) } },
      changes: field === "path" ? [] : proposal.review.changes,
    } });
    expect((await f.app.apply(f.scope, f.identity.relativePath)).kind).toBe("unconfirmed");
    expect(f.file.read().content).toBe("before");
    expect(f.file.readOperations()).toEqual([]);
    expect(f.confirmed).not.toHaveBeenCalled();
  } finally { f.disconnect(); }
});

it("retains newer input when source lookup completes after a user edit", async () => {
  const f = await fixture();
  let release!: (value: AgentProposalReview) => void;
  try {
    f.review.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.app.apply(f.scope, f.identity.relativePath);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.file.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" });
    release(f.proposal);
    expect((await pending).kind).toBe("unconfirmed");
    expect(f.file.read().content).toBe("manual before");
    expect(f.file.readOperations()).toEqual([]);
    expect(f.confirmed).not.toHaveBeenCalled();
  } finally { f.disconnect(); }
});

it("restores native delivery credentials without granting a fresh port permission to replay text", async () => {
  const f = await fixture();
  try {
    await f.app.apply(f.scope, f.identity.relativePath);
    f.file.resolveAll("keep");
    f.file.dispatch({ changes: { from: 0, insert: "manual " }, userEvent: "input.type" });
    await f.checkpoints.flushAll();
    const files = new WritingFileSessions();
    const checkpoint = [...f.storage.values()][0]!.checkpoint, restored = files.restore(checkpoint);
    const controller = new WritingCheckpointPersistence(files, createMemoryWritingCheckpointGateway(f.storage), vi.fn(), async (text) => hash(text));
    const disconnect = controller.connect();
    try {
      const outcome = await controller.applyEditorAgent(f.identity, { operationId: "operation", conversationId: "conversation", requestId: "request" },
        { operationId: "operation", expected: restored.applicationPort.read()!, text: "after" });
      expect(outcome.status).toBe("unconfirmed");
      expect(restored.read()).toMatchObject({ content: "manual after", reviewBaseline: "manual after" });
      expect(restored.readOperations()).toEqual(checkpoint.operations);
    } finally { disconnect(); }
  } finally { f.disconnect(); }
});

it("does not fabricate an editor receipt from a legacy checkpoint's current text or operation hash", async () => {
  const f = await fixture();
  try {
    await f.app.apply(f.scope, f.identity.relativePath);
    await f.checkpoints.flushAll();
    const record = [...f.storage.values()][0]!;
    const { editorReceipt: _receipt, ...legacy } = record.checkpoint;
    const storage = new Map([[JSON.stringify([legacy.manuscriptId, legacy.relativePath]), { ...record, checkpoint: legacy }]]);
    const files = new WritingFileSessions(), owner = new WritingCheckpointPersistence(files,
      createMemoryWritingCheckpointGateway(storage), vi.fn(), async (text) => hash(text));
    const disconnect = owner.connect();
    try {
      const restored = await owner.open(f.scope.manuscriptId, { relativePath: parseManuscriptPath(f.identity.relativePath),
        content: "before", sha256: hash("before") });
      expect(restored.read().content).toBe("after");
      expect(restored.applicationPort.readReceipt(f.scope.operationId)).toBeNull();
      expect(await owner.settleEditorAgent(f.identity, { operationId: "operation", conversationId: "conversation", requestId: "request" })).toBe(false);
      expect(restored.read()).toMatchObject({ content: "after", reviewBaseline: "before" });
    } finally { disconnect(); }
  } finally { f.disconnect(); }
});

it("checkpoints a file operation using reliable original provenance without reopening chat history", async () => {
  const f = await fixture();
  try {
    await f.app.apply(f.scope, f.identity.relativePath);
    f.review.mockRejectedValue(new Error("chat archived"));
    const delivery = createWritingFileOperationDelivery(f.files, f.checkpoints, f.scope);
    const scope = { ...f.scope, operationId: "independent-undo" }, port = f.file.applicationPort;
    const result = await delivery.apply(scope, f.identity.relativePath, port,
      { operationId: scope.operationId, expected: port.read()!, text: "before" });
    expect(result.status).toBe("applied");
    expect(await delivery.settle(scope, f.identity.relativePath, port)).toBe(true);
    const checkpoint = [...f.storage.values()][0]!.checkpoint;
    expect(checkpoint.editorReceipt).toMatchObject({ operationId: scope.operationId, text: "before" });
    expect(checkpoint.operations.at(-1)).toEqual({ operationId: scope.operationId,
      conversationId: "conversation", requestId: "request", resultSha256: hash("before") });
    expect(f.review).toHaveBeenCalledTimes(2); // Original application apply + settle only.
  } finally { f.disconnect(); }
});

it("retains file operation content after checkpoint failure and settles without repeating dispatch", async () => {
  const f = await fixture();
  try {
    await f.app.apply(f.scope, f.identity.relativePath);
    const save = f.save.getMockImplementation()!, delivery = createWritingFileOperationDelivery(f.files, f.checkpoints, f.scope);
    const scope = { ...f.scope, operationId: "restore" }, port = f.file.applicationPort;
    f.save.mockRejectedValue(new Error("checkpoint unavailable"));
    await expect(delivery.apply(scope, f.identity.relativePath, port,
      { operationId: scope.operationId, expected: port.read()!, text: "before" })).rejects.toThrow();
    expect(f.file.read().content).toBe("before");
    f.file.dispatch({ changes: { from: 0, insert: "new input " }, userEvent: "input.type" });
    f.save.mockImplementation(save);
    const apply = vi.spyOn(port, "apply");
    expect(await delivery.settle(scope, f.identity.relativePath, port)).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect([...f.storage.values()][0]!.checkpoint).toMatchObject({ content: "new input before",
      editorReceipt: { operationId: "restore", text: "before" } });
  } finally { f.disconnect(); }
});

it("retains the actually observed operation receipt after a post-dispatch exception", async () => {
  const f = await fixture();
  try {
    await f.app.apply(f.scope, f.identity.relativePath);
    const delivery = createWritingFileOperationDelivery(f.files, f.checkpoints, f.scope);
    const scope = { ...f.scope, operationId: "restore" }, port = f.file.applicationPort, apply = port.apply;
    vi.spyOn(port, "apply").mockImplementation(edit => { apply(edit); throw new Error("after dispatch"); });
    await expect(delivery.apply(scope, f.identity.relativePath, port,
      { operationId: scope.operationId, expected: port.read()!, text: "before" })).rejects.toThrow("after dispatch");
    expect(await delivery.settle(scope, f.identity.relativePath, port)).toBe(true);
    const checkpoint = [...f.storage.values()][0]!.checkpoint;
    expect(checkpoint.editorReceipt).toMatchObject({ operationId: "restore", text: "before" });
    const restored = new WritingFileSessions().restore(checkpoint);
    expect(restored.applicationPort.readReceipt("restore")).toEqual(port.readReceipt("restore"));
  } finally { f.disconnect(); }
});

it.each(["conversation", "manuscript", "proposal", "origin"])("rejects mismatched file operation provenance (%s)", async field => {
  const f = await fixture();
  try {
    await f.app.apply(f.scope, f.identity.relativePath);
    const owner = { ...f.scope, ...(field === "origin" ? { operationId: "missing" } : {}) };
    const delivery = createWritingFileOperationDelivery(f.files, f.checkpoints, owner);
    const scope = { ...f.scope, operationId: "restore",
      ...(field === "conversation" ? { conversationId: "other" } : field === "manuscript" ? { manuscriptId: "other" }
        : field === "proposal" ? { proposalId: "other" } : {}) };
    const port = f.file.applicationPort, apply = vi.spyOn(port, "apply");
    await expect(delivery.apply(scope, f.identity.relativePath, port,
      { operationId: scope.operationId, expected: port.read()!, text: "before" })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled(); expect(f.file.read().content).toBe("after");
  } finally { f.disconnect(); }
});
