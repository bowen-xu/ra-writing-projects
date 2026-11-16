import {fileURLToPath} from "node:url";
import {createPluginPreviewConfig} from "@research-assistant/workbench-preview/tooling";
export default await createPluginPreviewConfig({root: fileURLToPath(new URL("../", import.meta.url))});
