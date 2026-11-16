import type { AgentMetadataGateway } from "@research-assistant/data/agent";
import { WritingDemoTimedGate } from "./WritingDemoTimedGate";

/** Hold only metadata I/O; the real history hook controls loading and send availability. */
export class WritingDemoMetadataState {
  readonly gateway: AgentMetadataGateway;
  private readonly gate: WritingDemoTimedGate;
  private disposed = false;
  private failed = false;

  constructor(base: AgentMetadataGateway, readonly failFirstRead = false, durationMs = 3000) {
    this.gate = new WritingDemoTimedGate(failFirstRead ? undefined : durationMs);
    this.gateway = { read: async request => {
      await this.gate.wait();
      if (this.disposed) throw new Error("模拟会话核对已关闭");
      if (failFirstRead && !this.failed) {
        this.failed = true;
        throw new Error("模拟会话状态核对失败");
      }
      return base.read(request);
    } };
  }

  setDuration(durationMs: number): void { this.gate.setDuration(durationMs); }
  continue(): void { this.gate.release(); }
  dispose(): void { this.disposed = true; this.continue(); }
}
