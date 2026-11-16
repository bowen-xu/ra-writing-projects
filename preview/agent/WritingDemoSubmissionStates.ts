import type { WritingAgentRuntimeGateways } from "../../src/features/writing/agent/writingRuntimeGateways";
import { WritingDemoTimedGate } from "./WritingDemoTimedGate";

export type WritingDemoSubmissionScenario = "submissionPreparing" | "submissionPrepareFailed" | "submissionStartFailed" | "submissionCheckingFailed";

/** Pause or fail external I/O so the production send controller owns every UI state. */
export class WritingDemoSubmissionStates {
  readonly gateways: WritingAgentRuntimeGateways;
  private preparation: {
    readonly requestId: string;
    readonly gate: WritingDemoTimedGate;
  } | undefined;
  private disposed = false;
  private failed = false;

  constructor(base: WritingAgentRuntimeGateways, readonly scenario: WritingDemoSubmissionScenario, private durationMs = 3000) {
    this.gateways = {
      ...base,
      submission: {
        ...base.submission,
        prepareWriting: async request => {
          if (scenario === "submissionPreparing" || scenario === "submissionCheckingFailed") await this.wait(request.requestId);
          if (scenario === "submissionCheckingFailed") this.failOnce();
          if (scenario === "submissionPrepareFailed") this.failOnce();
          return base.submission.prepareWriting(request);
        },
        startWriting: async request => {
          if (this.disposed) throw new Error("模拟发送场景已关闭");
          if (scenario === "submissionStartFailed") this.failOnce("modelUnavailable");
          return base.submission.startWriting(request);
        },
      },
    };
  }

  continue(): void {
    this.preparation?.gate.release();
  }
  setDuration(durationMs: number): void { this.durationMs = durationMs; this.preparation?.gate.setDuration(durationMs); }
  dispose(): void { this.disposed = true; this.continue(); }
  private async wait(requestId: string): Promise<void> {
    if (this.disposed) throw new Error("模拟发送场景已关闭");
    // Keep a retry released, but pause again for the next submitted request.
    if (this.preparation?.requestId !== requestId) {
      this.preparation = { requestId, gate: new WritingDemoTimedGate(this.scenario === "submissionPreparing" ? this.durationMs : undefined) };
    }
    await this.preparation.gate.wait();
    if (this.disposed) throw new Error("模拟发送场景已关闭");
  }
  private failOnce(reason: unknown = new Error("模拟发送失败，重试可恢复")): void {
    if (this.failed) return;
    this.failed = true;
    throw reason;
  }
}
