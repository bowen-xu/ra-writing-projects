import type { EditorView, Panel } from "@codemirror/view";
import { createEditorSearchPanel } from "@research-assistant/workbench-sdk/code-editor-extensions";

export function createWritingSearchPanel(view: EditorView): Panel {
  return createEditorSearchPanel(view);
}
