import { useNotificationState } from "@research-assistant/workbench-sdk/feedback";
import { getAppStorage } from "@research-assistant/workbench-sdk/storage";
import { Compartment, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useState } from "react";

export interface EditorPreferences {
  readonly fontSize: number;
  readonly lineWrapping: boolean;
  readonly showLineNumbers: boolean;
  readonly tabSize: number;
}

const STORAGE_KEY = "research-assistant.writing.editor-preferences";
export const editorPreferencesCompartment = new Compartment();

export function readEditorPreferences(value: unknown): EditorPreferences {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    fontSize: typeof record.fontSize === "number" && [12, 14, 16, 18, 20].includes(record.fontSize) ? record.fontSize : 14,
    lineWrapping: record.lineWrapping !== false,
    showLineNumbers: record.showLineNumbers !== false,
    tabSize: record.tabSize === 4 ? 4 : 2,
  };
}

export function editorPreferenceExtensions(preferences: EditorPreferences): Extension {
  return [
    preferences.lineWrapping ? EditorView.lineWrapping : [],
    preferences.showLineNumbers ? lineNumbers() : [],
    indentUnit.of(" ".repeat(preferences.tabSize)),
    EditorView.theme({ ".cm-scroller": { fontSize: preferences.fontSize + "px" } }),
  ];
}

export function useEditorPreferences() {
  const [preferences, setPreferences] = useState(() => {
    try { return readEditorPreferences(JSON.parse(getAppStorage().getItem(STORAGE_KEY) ?? "null")); }
    catch { return readEditorPreferences(null); }
  });
  const [error, setError] = useNotificationState();
  function update(change: Partial<EditorPreferences>): void {
    const next = readEditorPreferences({ ...preferences, ...change });
    setPreferences(next);
    try { getAppStorage().setItem(STORAGE_KEY, JSON.stringify(next)); setError(undefined); }
    catch { setError("当前设置已生效，但无法记住偏好，下次打开可能恢复默认值。"); }
  }
  return { preferences, update, error };
}
