import { useNotificationState } from "@research-assistant/workbench-sdk/feedback";
import { useEffect, useRef, useState } from "react";
import type { Manuscript } from "@research-assistant/writing";

interface Props {
  manuscript: Manuscript;
  onDelete: (manuscript: Manuscript) => Promise<void>;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}

export function ManuscriptDeleteDialog({ manuscript, onDelete, onClose, returnFocus }: Props): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [, setError] = useNotificationState("error");
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  async function remove(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    try { await onDelete(manuscript); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <dialog ref={ref} className="writing-delete-dialog" aria-labelledby="delete-manuscript-title" onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <h2 id="delete-manuscript-title">永久删除“{manuscript.title}”？</h2>
    <p>此操作无法撤销。稿件源码、资源、写作笔记、恢复稿及编译记录将被清除。</p>
    <p>文献库、全局笔记和已下载的文件不受影响。需要保留副本时，请先导出源码 ZIP。</p>

    <footer><button ref={cancelRef} type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="writing-delete-confirm" disabled={busy} onClick={() => void remove()}>{busy ? "正在删除…" : "永久删除"}</button></footer>
  </dialog>;
}
