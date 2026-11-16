import { parseManuscriptPath } from "@research-assistant/writing";
import type { AppGateways } from "@research-assistant/workbench-preview/app-gateway-types";
import type { WritingRecoveryScenario } from "@research-assistant/workbench-preview/writing-recovery-preview";
import { initialChanges } from "@research-assistant/workbench-preview/writing-diff-fixtures";
import type { WritingGateway } from "../../../../../src/public/writingGateway.ts";

/** Faults affect only mock I/O. Production discovery, delivery, review and recovery
 * controllers still own all state transitions and notifications.
 */
export async function writingRecoveryFixture(storage: Storage, writing: WritingGateway,
  gateways: Partial<AppGateways>, scenario: WritingRecoveryScenario): Promise<Partial<AppGateways>> {
  const consume = (): boolean => {
    if (storage.getItem("writing-recovery-fault-consumed") === "1") return false;
    storage.setItem("writing-recovery-fault-consumed", "1");
    return true;
  };
  if (scenario === "stale" && consume()) {
    const manuscriptId = storage.getItem("initial-manuscript")!;
    const file = await writing.readFile(manuscriptId, "main.tex");
    // An undelivered frozen proposal coexists with a newer document, with no
    // application receipt. Never manufacture a failed/applied journal for it.
    await writing.saveFile({ manuscriptId, relativePath: parseManuscriptPath("main.tex"),
      content: initialChanges[0]!.after, expectedSha256: file.sha256 });
  }
  const deliveries = gateways.agentWritingFileDeliveryGateway!;
  const applications = gateways.agentApplicationGateway!;
  return {
    agentWritingFileDeliveryGateway: {
      ...deliveries,
      list: async request => {
        if (scenario === "discovery" && consume()) throw new Error("模拟文件交付记录读取失败");
        return deliveries.list(request);
      },
      acknowledge: async request => {
        await deliveries.acknowledge(request);
        if (scenario === "acknowledgement" && consume()) throw new Error("模拟交付签收回复丢失");
      },
    },
    agentApplicationGateway: {
      ...applications,
      find: request => applications.find(request),
      execute: async request => {
        if (scenario === "application" && request.action === "confirmEditor"
          && request.actual.path === initialChanges.at(-1)!.path && consume()) throw new Error("模拟最后文件签收失败");
        return applications.execute(request);
      },
    },
  };
}
