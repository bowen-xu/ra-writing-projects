import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";
import {createPluginPreviewConfig} from "@research-assistant/workbench-preview/tooling";
const config = await createPluginPreviewConfig({root: fileURLToPath(new URL("../", import.meta.url))});
export default defineConfig({...config, test: {
  include: ["agent/**/*.test.{ts,tsx}"],
  execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage") ? ["--no-experimental-webstorage"] : [],
}});
