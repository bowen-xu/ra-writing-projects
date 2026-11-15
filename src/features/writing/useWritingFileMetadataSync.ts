import { useEffect, useRef } from "react";
import type { ManuscriptFile } from "@research-assistant/writing";
import type { WritingGateway } from "./gateway";

/** Returning from an external editor checks identities/hashes, not every file body. */
export function useWritingFileMetadataSync(options: {
  readonly manuscriptId: string | undefined;
  readonly gateway: WritingGateway;
  readonly canRead: () => boolean;
  readonly onFiles: (files: readonly ManuscriptFile[]) => void;
  readonly onError: (reason: unknown) => void;
}): void {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    const id = options.manuscriptId;
    if (!id) return;
    let alive = true, reading = false;
    const refresh = () => {
      if (!alive || reading || document.visibilityState === "hidden" || !latest.current.canRead()) return;
      reading = true;
      void options.gateway.listFiles(id).then(files => {
        if (alive && latest.current.manuscriptId === id && latest.current.canRead()) latest.current.onFiles(files);
      }).catch(reason => {if (alive) latest.current.onError(reason);}).finally(() => {reading = false;});
    };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => {alive = false; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);};
  }, [options.manuscriptId, options.gateway]);
}
