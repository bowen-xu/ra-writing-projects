import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import preview from "./vite.config.mts";

const require = createRequire(import.meta.url);
const reactEntries = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-dom/test-utils", "lucide-react"];
export default defineConfig({...preview,
  resolve: {...preview.resolve, alias: [
    ...reactEntries.map(name => ({find: new RegExp("^" + name.replaceAll("/", "\\/") + "$"), replacement: require.resolve(name)})),
    ...Object.entries(preview.resolve.alias).map(([find, replacement]) => ({find, replacement})),
  ]},
  test: {
  include: ["agent/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
  setupFiles: ["browser-test-setup", "markdown-test-setup"].map(name =>
    fileURLToPath(import.meta.resolve("@research-assistant/workbench-preview/" + name))),
  execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage") ? ["--no-experimental-webstorage"] : [],
}});
