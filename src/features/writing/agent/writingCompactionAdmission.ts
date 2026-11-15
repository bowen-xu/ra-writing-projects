import type {AgentWritingReceipt} from "@research-assistant/core/agent";

type Step = "prepare" | "start";
export interface WritingCompactionAdmissionSnapshot {
  readonly prepareMayHaveDispatched: boolean;
  readonly startMayHaveDispatched: boolean;
  readonly blockedBeforeDispatch: Step | null;
}
const initial = (): WritingCompactionAdmissionSnapshot => ({prepareMayHaveDispatched: false, startMayHaveDispatched: false, blockedBeforeDispatch: null});

export class WritingCompactionAdmissionClosed extends Error {
  readonly code = "WRITING_COMPACTION_ADMISSION_CLOSED";
  constructor(readonly step: Step, readonly definitelyUnsent: boolean, readonly identity: AgentWritingReceipt) {
    super("写作插件已停用，当前步骤尚未派发，原请求已保留。");
  }
}

/** Process-local dispatch evidence belongs to the original owner. It is never
 * persisted, and a cold locator cannot establish that an RPC was unsent. */
export class WritingCompactionAdmission {
  private state = initial();
  constructor(private readonly isDisabled: () => boolean, private readonly changed: () => void) {}
  getSnapshot = (): WritingCompactionAdmissionSnapshot => this.state;
  reset(): void {this.state = initial();}
  restore(hasStart: boolean): void {
    this.state = {prepareMayHaveDispatched: true, startMayHaveDispatched: hasStart, blockedBeforeDispatch: null};
  }
  failedBeforeDispatch(step: Step): void {
    const field = step === "prepare" ? "prepareMayHaveDispatched" : "startMayHaveDispatched";
    if (!this.state[field]) this.state = {...this.state, blockedBeforeDispatch: step};
  }
  beforeDispatch(step: Step, identity: AgentWritingReceipt, replayUnknown = false): void {
    const field = step === "prepare" ? "prepareMayHaveDispatched" : "startMayHaveDispatched";
    if (this.isDisabled() && !(replayUnknown && this.state[field])) {
      const definitelyUnsent = !this.state[field];
      this.state = {...this.state, blockedBeforeDispatch: definitelyUnsent ? step : null}; this.changed();
      throw new WritingCompactionAdmissionClosed(step, definitelyUnsent, {conversationId: identity.conversationId,
        manuscriptId: identity.manuscriptId, requestId: identity.requestId});
    }
    // Do not publish between this final live read and the caller's RPC.
    this.state = {...this.state, [field]: true, blockedBeforeDispatch: null};
  }
}
