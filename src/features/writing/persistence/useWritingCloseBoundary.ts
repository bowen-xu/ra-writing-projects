import { isWritingNotePath } from "@research-assistant/writing";
import { useEffect, useId, useRef } from "react";
import { getReaderCloseCoordinator } from "@research-assistant/workbench-sdk/workbench";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { errorMessage } from "../workspaceState";
import type { WritingPersistenceControl } from "../useWritingPersistence";
import type { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import type { WritingFileSaveQueue } from "./WritingFileSaveQueue";
import { prepareWritingClose } from "./writingCloseBoundary";

interface Options {
  readonly onRegistered?: () => void | (() => void);
  readonly prepareFileTasks?: () => Promise<boolean>;
  readonly activePath: string | undefined;
  readonly saveCurrent: () => Promise<boolean>;
  readonly persistCurrent: Pick<WritingPersistenceControl, "flushSession">;
  readonly fileSaves: WritingFileSaveQueue;
  readonly checkpoints: WritingCheckpointPersistence;
}

/** Register a workspace participant without treating chat visibility as a close boundary. */
export function useWritingCloseBoundary(options: Options): void {
  const id = useId(), current = useRef(options);
  current.current = options;
  useEffect(() => {
    const unregister = getReaderCloseCoordinator().register(`writing:${id}`, {
      isActive: () => false,
      commit: () => undefined,
      prepare: async () => {
        const host = current.current;
        try {if (host.prepareFileTasks && !await host.prepareFileTasks()) return false;}
        catch (reason) {notify.error(`文件操作尚未完成，请核对后重试关闭：${errorMessage(reason)}`); return false;}
        // Writing Notes retain their own attachment/encoding gate and legacy persistence.
        if (isWritingNotePath(host.activePath) && !(await host.saveCurrent())) return false;
        return prepareWritingClose({ saves: host.fileSaves, checkpoints: host.checkpoints,
          flushSession: () => host.persistCurrent.flushSession?.() ?? Promise.resolve(),
          onRecoverable: () => notify.warning("部分保存尚未完成；完整编辑状态已可靠暂存，重新打开后可继续保存。"),
          onFailure: (reason) => notify.error(`编辑状态未能可靠暂存，请重试保存或取消关闭：${errorMessage(reason)}`),
        });
      },
    });
    let release: void | (() => void);
    try { release = current.current.onRegistered?.(); }
    catch (reason) { unregister(); throw reason; }
    return () => {
      try { release?.(); }
      finally { unregister(); }
    };
  }, [id]);
}
