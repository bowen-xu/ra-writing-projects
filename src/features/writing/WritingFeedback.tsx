import type { BibliographyStatus, CitationUsage, RecoveryDraft } from "@research-assistant/writing";
import { NotificationEffect } from "@research-assistant/workbench-sdk/feedback";

interface WritingFeedbackProps {
  readonly manuscriptId?: string | undefined;
  readonly bibliographyStatus: BibliographyStatus | undefined;
  readonly citationUsage: CitationUsage;
  readonly pendingRecovery: RecoveryDraft | undefined;
  readonly onDiscardRecovery: (draft: RecoveryDraft) => void;
  readonly onResolveBibliography: (preserve: boolean) => void;
  readonly onRestoreRecovery: (draft: RecoveryDraft) => void;
}

export function WritingFeedback(props: WritingFeedbackProps): React.JSX.Element {
  const recovery = props.pendingRecovery;
  return (
    <>
      {recovery !== undefined && (
        <div className="writing-recovery-actions">
          <span>{recovery.relativePath}</span>
          <button onClick={() => props.onRestoreRecovery(recovery)} type="button">恢复</button>
          <button onClick={() => props.onDiscardRecovery(recovery)} type="button">丢弃</button>
        </div>
      )}
      {props.bibliographyStatus?.status === "conflict" && (
        <div className="writing-recovery-actions">
          <span>参考文献文件</span>
          <button onClick={() => props.onResolveBibliography(true)} type="button">备份外部版本并恢复</button>
        </div>
      )}
      <NotificationEffect id={`writing-bibliography-conflict:${props.manuscriptId ?? "current"}`} message={props.bibliographyStatus?.status === "conflict" ? "参考文献文件在应用外发生变化。原内容已保留，可先备份再恢复受管版本。" : undefined} />
      <NotificationEffect id={`writing-recovery:${props.manuscriptId ?? "current"}`} message={recovery ? `发现 ${recovery.relativePath} 的未保存恢复稿。` : undefined} />
      <NotificationEffect id={`writing-citations-missing:${props.manuscriptId ?? "current"}`}
        message={props.citationUsage.missingKeys.length ? `缺失引用：${keysLabel(props.citationUsage.missingKeys)}` : undefined} />
    </>
  );
}

function keysLabel(keys: readonly string[]): string { return keys.length>8 ? `${keys.slice(0,8).join(", ")} 等 ${keys.length} 条` : keys.join(", "); }
