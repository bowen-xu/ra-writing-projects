import {decodeCodexCatalogVersions, type CodexCatalogVersionGateway, type CodexCatalogVersions} from "@research-assistant/workbench-preview/codex-catalog-version-gateway";

/** Synthetic versions for the browser harness; never discovers or installs a CLI. */
export function createMockCodexCatalogVersions(storage: Storage): CodexCatalogVersionGateway {
  const key = "codex-catalog-versions";
  let value: CodexCatalogVersions = {runtimeVersion: "0.146.0", selectedVersion: "0.146.0", availableVersions: ["0.146.0"]};
  try { value = decodeCodexCatalogVersions(JSON.parse(storage.getItem(key) ?? "null")) ?? value; }
  catch { /* A malformed preview fixture resets to its initial versions. */ }
  const save = (next: CodexCatalogVersions): CodexCatalogVersions => {
    storage.setItem(key, JSON.stringify(next));
    value = next;
    return structuredClone(value);
  };
  return {
    getVersions: async refresh => refresh
      ? save({...value, availableVersions: [...new Set(["0.200.0", value.selectedVersion, value.runtimeVersion, ...value.availableVersions])].slice(0, 20)})
      : structuredClone(value),
    selectVersion: async version => {
      if (!value.availableVersions.includes(version)) throw new Error("模拟版本不可选（codex_version_invalid）");
      return save({...value, selectedVersion: version});
    },
  };
}
