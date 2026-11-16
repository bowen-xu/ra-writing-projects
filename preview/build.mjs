import {fileURLToPath} from "node:url";
import {withCachedBuild} from "../.dependencies/sdk/tooling/build-artifacts.mjs";
import {buildPluginPreview} from "@research-assistant/workbench-preview/tooling";
const receipt = await buildPluginPreview({root: fileURLToPath(new URL("../", import.meta.url)), withCachedBuild});
console.log(JSON.stringify({status: receipt.status, output: receipt.output, cacheHit: receipt.cacheHit, receipt: receipt.receipt}));
