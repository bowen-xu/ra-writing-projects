import "../src/app/runtime/appPreviewDatabase";
import {createRoot} from "react-dom/client";
import {NotesProvider} from "@research-assistant/workbench-preview/notes-client";
import {ApplicationKeyboardPolicy} from "@research-assistant/workbench-preview/application-keyboard-policy";
import {TableReviewPreview} from "@research-assistant/workbench-preview/table-review-preview";
import type {NotesGateway} from "@research-assistant/data/notes";
import "@research-assistant/workbench-preview/styles/global";
const gateway = new Proxy({}, {get: (_target, command) => async () => {
  throw new Error(`TABLE_PREVIEW_UNSUPPORTED：此内存示例未连接 ${String(command)}。`);
}}) as NotesGateway;
createRoot(document.getElementById("root")!).render(<NotesProvider gateway={gateway}>
  <ApplicationKeyboardPolicy/><TableReviewPreview/>
</NotesProvider>);
