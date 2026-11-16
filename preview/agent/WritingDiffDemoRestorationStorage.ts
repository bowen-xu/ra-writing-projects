import { createAgentEditorRestorationGateway } from "@research-assistant/data/agent";
import type { AgentApplicationScope, AgentApplicationState, AgentEditorRestoration, AgentEditorRestorationRequest } from "@research-assistant/core/agent";
import type { DemoChange } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import type { WritingDiffDemoStorage } from "./WritingDiffDemoStorage";
import { writingDiffDemoBytes, writingDiffDemoText } from "./WritingDiffDemoBytes";

interface Entry { application: AgentApplicationState | null; readonly texts: readonly DemoChange[] }
const keyFor = (scope: AgentApplicationScope, path: string) => JSON.stringify([
  scope.manuscriptId, scope.conversationId, scope.proposalId, scope.operationId, path]);

/** Mock native intent/receipt storage only. Editor restoration transactions and
 * manuscript exclusion remain in the production workspace coordinator. */
export class WritingDiffDemoRestorationStorage {
  snapshot() { return structuredClone({ intents: this.intents }); }
  restore(snapshot: ReturnType<WritingDiffDemoRestorationStorage["snapshot"]>): void {
    this.intents.clear(); for (const entry of snapshot.intents) this.intents.set(entry[0], entry[1]);
  }

  private readonly intents = new Map<string, AgentEditorRestoration>();
  failConfirmation = false;
  constructor(private readonly disk: WritingDiffDemoStorage["files"], private readonly readEntry: (scope: AgentApplicationScope) => Entry,
    private readonly admissibleStatuses: readonly AgentApplicationState["status"][] = ["prepared", "applying", "recoveryRequired"],
    private readonly authorizeRebuilt?: (request: Extract<AgentEditorRestorationRequest, {action: "prepare"}>) => Promise<void>) {
    this.gateway = createAgentEditorRestorationGateway(async (_command, args) => this.execute(args.request as AgentEditorRestorationRequest));
  }
  readonly gateway: ReturnType<typeof createAgentEditorRestorationGateway>;
  private checked(scope: AgentApplicationScope) {
    const entry = this.readEntry(scope), state = entry.application;
    if (!state || (["manuscriptId", "conversationId", "proposalId", "operationId"] as const)
      .some(field => state.scope[field] !== scope[field])) throw new Error("模拟恢复操作身份不匹配");
    return { entry, state };
  }
  private response(entry: Entry, path: string) {
    return { kind: "state", schemaVersion: 1, application: structuredClone(entry.application), path,
      restoration: structuredClone(this.intents.get(keyFor(entry.application!.scope, path)) ?? null) };
  }
  private async execute(request: AgentEditorRestorationRequest) {
    const { entry, state } = this.checked(request.scope);
    const path = request.action === "read" ? request.path : request.action === "prepare" ? request.current.path : request.actual.path;
    const file = state.files.find(item => item.path === path), change = entry.texts.find(item => item.path === path);
    if (!file || file.target.kind !== "editor" || !change) throw new Error("模拟恢复编辑器目标不存在");
    const key = keyFor(request.scope, path), intent = this.intents.get(key);
    if (request.action === "read") return this.response(entry, path);
    if (request.action === "prepare") {
      if (intent) {
        if (intent.id !== request.restoreId) throw new Error("模拟恢复意图不可替换");
        return this.response(entry, path);
      }
      const before = writingDiffDemoText(writingDiffDemoBytes(change, "before")), after = writingDiffDemoText(writingDiffDemoBytes(change, "after"));
      if (file.target.sessionId !== request.current.sessionId || request.checkpointVersion) {
        if (!this.authorizeRebuilt) throw new Error("模拟应用恢复不允许更换拥有者");
        await this.authorizeRebuilt(request);
      }
      if (!this.admissibleStatuses.includes(state.status) || file.phase !== "acknowledged"
        || (file.target.sessionId === request.current.sessionId && file.target.resultRevision !== request.current.revision)
        || before === null || after === null || request.current.text !== after) throw new Error("模拟恢复编辑器版本冲突");
      this.intents.set(key, { id: request.restoreId, sessionId: request.current.sessionId,
        expectedRevision: request.current.revision, resultRevision: null });
      entry.application = { ...state, status: "recoveryRequired" };
      return { kind: "edit", schemaVersion: 1, scope: request.scope, restoreId: request.restoreId, expected: request.current, text: before };
    }
    if (!intent || intent.id !== request.restoreId || intent.sessionId !== request.actual.sessionId
      || intent.expectedRevision === request.actual.revision || request.actual.text !== writingDiffDemoText(writingDiffDemoBytes(change, "before"))
      || (intent.resultRevision !== null && intent.resultRevision !== request.actual.revision)) throw new Error("模拟恢复回执不匹配");
    if (intent.resultRevision !== null) return this.response(entry, path);
    if (state.status !== "recoveryRequired" || file.phase !== "acknowledged" || this.failConfirmation) throw new Error("模拟恢复签收日志尚未确认");
    this.intents.set(key, { ...intent, resultRevision: request.actual.revision });
    const files = state.files.map(item => item === file ? { ...item, phase: "restored" as const } : item);
    entry.application = { ...state, files, status: files.every(item => item.phase === "pending" || item.phase === "restored") ? "rolledBack" : "recoveryRequired" };
    return this.response(entry, path);
  }
  async rollback(scope: AgentApplicationScope, allowEditors: boolean): Promise<AgentApplicationState> {
    const { entry, state } = this.checked(scope);
    if (state.status === "rolledBack") return structuredClone(state);
    if (!this.admissibleStatuses.includes(state.status) || state.files.some(file => {
      if (file.phase === "conflict") return true;
      if (file.target.kind === "disk") return false;
      if (!allowEditors) return true;
      const intent = this.intents.get(keyFor(scope, file.path));
      return file.phase === "pending" ? !!intent : file.phase !== "restored" || !intent?.resultRevision;
    })) throw new Error("模拟回滚尚有未核对编辑器目标");
    entry.application = { ...state, status: "recoveryRequired" };
    for (const file of [...state.files].reverse()) {
      if (file.phase === "pending" || file.phase === "restored") continue;
      const change = entry.texts.find(item => item.path === file.path);
      if (!change) throw new Error("模拟回滚缺少冻结内容");
      await this.disk.restoreChange(scope.manuscriptId, file.path, change.kind === "added" ? null : writingDiffDemoBytes(change, "before"),
        change.kind === "deleted" ? null : writingDiffDemoBytes(change, "after"), scope.operationId);
      entry.application = { ...entry.application, files: entry.application.files.map(item => item.path === file.path ? { ...item, phase: "restored" } : item) };
    }
    entry.application = { ...entry.application, status: "rolledBack" };
    return structuredClone(entry.application);
  }
  hasIntent(scope: AgentApplicationScope): boolean {
    return this.checked(scope).state.files.some(file => this.intents.has(keyFor(scope, file.path)));
  }
  readIntent(scope: AgentApplicationScope, path: string): AgentEditorRestoration | null {
    this.checked(scope);
    return structuredClone(this.intents.get(keyFor(scope, path)) ?? null);
  }
}
