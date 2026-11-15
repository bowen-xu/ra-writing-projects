import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import type { ReactNode } from "react";
import { FileClock } from "lucide-react";
import "./WritingUndoRecovery.css";

/** One workspace feedback stack, shared with the mock gateway harness. */
export function WritingFileRecoveryFeedback({ delivery, undo }: {
  readonly delivery: ReactNode;
  readonly undo: ReactNode;
}): React.JSX.Element {
  return <details className="writing-file-recovery-stack" aria-label="文件操作恢复">
    <ControlHint content="查看待处理的 Agent 文件修改与恢复操作；普通编辑可继续"><summary aria-label="文件修改待处理">
      <FileClock size={16} aria-hidden="true"/>
    </summary></ControlHint>
    <div className="writing-file-recovery-content">{delivery}{undo}</div>
  </details>;
}
