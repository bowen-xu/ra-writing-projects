import {defineConfig} from "vitest/config";
import production from "./vite.config.ts";
import {runtimeSdkTestPlugin} from "./.dependencies/sdk/tooling/runtime-sdk-tests.mjs";
const paths = (production.build!.rolldownOptions!.output as {paths: (id: string) => string}).paths;
export default defineConfig({plugins: [runtimeSdkTestPlugin(paths)], test: {
  exclude: ["preview/**", "artifacts/**", ".cache/**", "**/node_modules/**", ".tmp/**", ".dependencies/**", "build/**"],
  execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage") ? ["--no-experimental-webstorage"] : [],
}});
