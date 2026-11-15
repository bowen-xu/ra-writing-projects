import type { KeyboardEvent } from "react";
import type { WritingViewMode } from "./useWritingLayout";
import { isWritingMac } from "./WritingLayoutMenu";

export function writingLayoutAction(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, mac: boolean): WritingViewMode | "focus" | undefined {
  if (event.altKey) return undefined;
  if (event.key.toLowerCase() === "m" && event.shiftKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return "focus";
  if (mac && event.ctrlKey && event.metaKey && !event.shiftKey) return ({ ArrowDown: "split", ArrowLeft: "editor", ArrowRight: "preview" } as const)[event.key as "ArrowDown"];
  return undefined;
}

export function handleWritingLayoutShortcut(event: KeyboardEvent, onMode: (mode: WritingViewMode) => void, onFocus: () => void): void {
  if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat || document.querySelector('dialog[open], [aria-modal="true"]')) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select")) return;
  const action = writingLayoutAction(event, isWritingMac());
  if (!action) return;
  event.preventDefault(); event.stopPropagation();
  if (action === "focus") onFocus(); else onMode(action);
}
