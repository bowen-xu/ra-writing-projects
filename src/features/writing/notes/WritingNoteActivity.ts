import { createContext, useCallback, useMemo, useRef } from "react";

interface NoteActivity {
  begin: () => () => void;
  invalid: (message: string | undefined) => void;
}
export const WritingNoteActivity = createContext<NoteActivity | undefined>(undefined);
/** Prevent navigation/export from dropping a not-yet-inserted attachment or an unencodable edit. */
export function useWritingNoteActivity(save: () => Promise<boolean>, onError: (message: string) => void) {
  const busy = useRef(0);
  const error = useRef<string | undefined>(undefined);
  const activity = useMemo<NoteActivity>(() => ({
    begin: () => { busy.current++; let finished = false; return () => { if (!finished) busy.current--; finished = true; }; },
    invalid: (message) => { error.current = message; },
  }), []);
  const saveCurrent = useCallback(async () => {
    const message = error.current ?? (busy.current ? "附件正在导入，请完成后再保存、切换或导出。" : undefined);
    if (message) { onError(message); return false; }
    return save();
  }, [save, onError]);
  return { activity, saveCurrent };
}
