import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildNativePlugin, dependencyPaths} from "../.dependencies/sdk/tooling/native-plugin-build.mjs";
export {dependencyPaths};
export async function buildWritingNativePlugin() {return buildNativePlugin("writing_projects", process.argv.slice(2));}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWritingNativePlugin();
