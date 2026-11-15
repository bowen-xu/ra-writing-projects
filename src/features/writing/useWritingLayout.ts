import { boundedWritingWidth, writingResizeBounds } from "./writingResizeBounds";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

export type WritingPane = "explorer" | "editor" | "preview";
export type WritingViewMode = "split" | "editor" | "preview";

export interface WritingLayoutPreferences {
  readonly explorerWidth: number;
  readonly previewWidth: number;
  readonly narrowPane: WritingPane;
  readonly viewMode: WritingViewMode;
  readonly explorerVisible: boolean;
}

const DEFAULT_LAYOUT: WritingLayoutPreferences = {
  explorerWidth: 220,
  previewWidth: 420,
  narrowPane: "editor",
  viewMode: "split",
  explorerVisible: true,
};

interface WritingLayout {
  readonly preferences: WritingLayoutPreferences;
  readonly focused: boolean;
  readonly toggleFocus: () => void;
  readonly exitFocus: () => void;
  readonly reveal: (pane: "editor" | "preview") => void;
  readonly keyResize: (edge: "explorer" | "preview", event: KeyboardEvent<HTMLDivElement>) => void;
  readonly persistenceState: Readonly<Record<string, unknown>>;
  readonly gridStyle: CSSProperties;
  readonly restore: (value: unknown) => void;
  readonly selectNarrowPane: (pane: WritingPane) => void;
  readonly setViewMode: (mode: WritingViewMode) => void;
  readonly toggleExplorer: () => void;
  readonly startResize: (edge: "explorer" | "preview", event: PointerEvent<HTMLDivElement>) => void;
}

export function useWritingLayout(): WritingLayout {
  const [preferences, setPreferences] = useState(DEFAULT_LAYOUT);
  const [focusSnapshot, setFocusSnapshot] = useState<WritingLayoutPreferences>();
  const snapshotRef = useRef<WritingLayoutPreferences | undefined>(undefined);
  const toggleFocus = useCallback(() => {
    if (snapshotRef.current) { setPreferences(snapshotRef.current); snapshotRef.current = undefined; setFocusSnapshot(undefined); }
    else { snapshotRef.current = preferences; setFocusSnapshot(preferences); setPreferences({ ...preferences, narrowPane: preferences.narrowPane === "explorer" ? "editor" : preferences.narrowPane }); }
  }, [preferences]);
  const exitFocus = useCallback(() => {
    if (snapshotRef.current) setPreferences(snapshotRef.current);
    snapshotRef.current = undefined; setFocusSnapshot(undefined);
  }, []);
  const resizeCleanupRef = useRef<() => void>(() => undefined);
  useEffect(() => () => resizeCleanupRef.current(), []);
  const restore = useCallback((value: unknown) => {
    const preferences=readWritingLayoutPreferences(value);
    const focused=!!value && typeof value === "object" && "focused" in value && value.focused === true;
    snapshotRef.current=focused?preferences:undefined;setFocusSnapshot(snapshotRef.current);setPreferences(preferences);
  }, []);
  const selectNarrowPane = useCallback((narrowPane: WritingPane) => {
    setPreferences((current) => ({ ...current, narrowPane }));
  }, []);
  const setViewMode = useCallback((viewMode: WritingViewMode) => {
    setPreferences((current) => ({ ...current, viewMode, narrowPane: viewMode === "preview" ? "preview" : "editor" }));
  }, []);
  const reveal = useCallback((pane: "editor" | "preview") => setPreferences((current) => ({ ...current, narrowPane: pane, viewMode: current.viewMode === "split" ? "split" : pane })), []);
  const keyResize = useCallback((edge: "explorer" | "preview", event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const bounds = writingResizeBounds(edge, event.currentTarget);
    setPreferences((current) => {
      const key = edge === "explorer" ? "explorerWidth" : "previewWidth";
      const { minimum: min, maximum: max } = bounds;
      const delta = (event.key === "ArrowRight" ? 1 : -1) * (edge === "explorer" ? 1 : -1) * (event.shiftKey ? 64 : 16);
      return { ...current, [key]: event.key === "Home" ? min : event.key === "End" ? max : boundedWritingWidth(boundedWritingWidth(current[key], bounds) + delta, bounds) };
    });
  }, []);
  const toggleExplorer = useCallback(() => setPreferences((current) => ({ ...current, explorerVisible: !current.explorerVisible })), []);
  const startResize = useCallback((edge: "explorer" | "preview", event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current();
    const target = event.currentTarget;
    let lastX = event.clientX;
    const key = edge === "explorer" ? "explorerWidth" : "previewWidth";
    let width = boundedWritingWidth(preferences[key], writingResizeBounds(edge, target));
    setPreferences(current => current[key] === width ? current : { ...current, [key]: width });
    const onMove = (moveEvent: globalThis.PointerEvent): void => {
      const delta = (moveEvent.clientX - lastX) * (edge === "explorer" ? 1 : -1);
      lastX = moveEvent.clientX;
      width = boundedWritingWidth(width + delta, writingResizeBounds(edge, target));
      const nextWidth = width;
      setPreferences(current => current[key] === nextWidth ? current : { ...current, [key]: nextWidth });
    };
    const onEnd = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      resizeCleanupRef.current = () => undefined;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    resizeCleanupRef.current = onEnd;
  }, [preferences.explorerWidth, preferences.previewWidth]);
  const gridStyle = useMemo(() => ({
    "--writing-explorer-width": `${preferences.explorerWidth}px`,
    "--writing-preview-width": `${preferences.previewWidth}px`,
  }) as CSSProperties, [preferences.explorerWidth, preferences.previewWidth]);
  const persistenceState = useMemo(() => ({ ...(focusSnapshot ?? preferences), focused:focusSnapshot !== undefined }), [focusSnapshot, preferences]);
  return { preferences, focused: focusSnapshot !== undefined, toggleFocus, exitFocus, reveal, keyResize, persistenceState, gridStyle, restore, selectNarrowPane, setViewMode, toggleExplorer, startResize };
}

export function readWritingLayoutPreferences(value: unknown): WritingLayoutPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_LAYOUT;
  const record = value as Record<string, unknown>;
  return {
    viewMode: record.viewMode === "editor" || record.viewMode === "preview" ? record.viewMode : "split",
    explorerVisible: record.explorerVisible !== false,
    explorerWidth: boundedNumber(record.explorerWidth, 160, 380, DEFAULT_LAYOUT.explorerWidth),
    previewWidth: boundedNumber(record.previewWidth, 280, 720, DEFAULT_LAYOUT.previewWidth),
    narrowPane: record.narrowPane === "explorer" || record.narrowPane === "preview"
      ? record.narrowPane
      : "editor",
  };
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback;
}
