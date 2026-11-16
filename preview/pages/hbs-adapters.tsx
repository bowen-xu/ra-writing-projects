import {createRoot} from "react-dom/client";
import {NotesProvider} from "@research-assistant/workbench-preview/notes-client";
import {ApplicationKeyboardPolicy} from "@research-assistant/workbench-preview/application-keyboard-policy";
import {HbsAdaptersPreview} from "@research-assistant/workbench-preview/hbs-adapters-preview";
import {noteRendererGateway} from "@research-assistant/workbench-preview/hbs-note-renderer-gateway";
import "@research-assistant/workbench-preview/styles/global";
createRoot(document.getElementById("root")!).render(<NotesProvider gateway={noteRendererGateway}>
  <ApplicationKeyboardPolicy/><HbsAdaptersPreview/>
</NotesProvider>);
