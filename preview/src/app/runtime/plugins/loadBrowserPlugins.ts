import {packageMetadata as literatureMetadata} from "@research-assistant/literature-library-preview";
import {packageMetadata as notesMetadata} from "@research-assistant/note-manager-preview";
import writingMetadata from "../../../../../package.json";
import {decodePluginManifest, WORKBENCH_UI_RUNTIME} from "@research-assistant/workbench-sdk";
import {resolveBuiltinPlugins} from "@research-assistant/workbench-sdk/composition";
import {literatureLibraryManifest} from "@research-assistant/literature-library-preview";
import {noteManagerManifest} from "@research-assistant/note-manager-preview";
import {writingProjectsManifest} from "../../../../../src/public/manifest.ts";
import type {RuntimePluginModule} from "@research-assistant/workbench-sdk/activation";
import type {RuntimePluginLoadResult} from "@research-assistant/workbench-preview/loader";
import {coreCapabilities} from "@research-assistant/workbench-preview/core-capabilities";

/** Browser previews import the real plugin activation entries and retain their
 * injected gateways. Desktop discovery continues to use verified package URLs. */
export async function loadBrowserPlugins(): Promise<RuntimePluginLoadResult> {
  const catalog = [
    {declaration: literatureLibraryManifest, version: literatureMetadata.version, load: () => import("@research-assistant/literature-library-preview")},
    {declaration: writingProjectsManifest, version: writingMetadata.version, load: () => import("../../../../../src/index.ts")},
    {declaration: noteManagerManifest, version: notesMetadata.version, load: () => import("@research-assistant/note-manager-preview")},
  ];
  const manifests = catalog.map(({declaration, version}) => decodePluginManifest({...declaration,
    formatVersion: 1, version, entry: "src/index.js", styles: [], uiRuntime: WORKBENCH_UI_RUNTIME}));
  const resolution = resolveBuiltinPlugins(manifests, manifests.map(manifest => manifest.id), coreCapabilities);
  const plugins = await Promise.all(resolution.activationOrder.map(async manifest => {
    const source = catalog.find(item => item.declaration.id === manifest.id)!;
    const module: RuntimePluginModule = await source.load();
    return {manifest, module, entryUrl: "/plugins/" + manifest.id + "/src/index.ts", styles: []};
  }));
  return {plugins, bindings: resolution.bindings, unavailableOptional: resolution.unavailableOptional};
}
