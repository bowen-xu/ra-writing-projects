import { useEffect } from "react";

/** The shell follows the workbench lifetime, including note tabs and file loading. */
export function useWritingWorkbenchVisibility(isLibraryOpen: boolean, onVisibilityChange?: (visible: boolean) => void): void {
  useEffect(() => { onVisibilityChange?.(!isLibraryOpen); }, [isLibraryOpen, onVisibilityChange]);
  useEffect(() => () => onVisibilityChange?.(false), [onVisibilityChange]);
}
