import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {test} from "node:test";
import {buildWritingNativePlugin, dependencyPaths} from "./build-writing-native-plugin.mjs";
import {assertWritingProjectNativeBuildManifest, buildNativePlugin, dependencyPaths as sharedDependencyPaths} from "../.dependencies/sdk/tooling/native-plugin-build.mjs";

test("dep-info auditing reads escaped source names and continuation lines, never the build target", () => {
  assert.deepEqual(dependencyPaths([
    "/tmp/target/binary.d: /tmp/staging/src/main.rs /tmp/staging/a\\ b.rs \\",
    " /tmp/staging/src/lib.rs",
    "/tmp/target/binary: /tmp/staging/src/main.rs",
    "/tmp/staging/src/main.rs:",
    "# env-dep:CARGO_PKG_VERSION=0.1.0",
  ].join("\n")), ["/tmp/staging/a b.rs", "/tmp/staging/src/lib.rs", "/tmp/staging/src/main.rs"]);
});

test("the original writing wrapper keeps its zero-argument function and shared dep-info parser", () => {
  assert.equal(buildWritingNativePlugin.length, 0);
  assert.equal(dependencyPaths, sharedDependencyPaths);
});

test("the writing command rejects unknown flags before constructing an independent build", () => {
  const result = spawnSync(process.execPath, ["scripts/build-writing-native-plugin.mjs", "--online"], {encoding: "utf8"});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node scripts\/build-writing-native-plugin\.mjs \[--offline\] \[--project-files\] \(always locked\/offline\)/u);
  assert.equal(result.stdout, "");
});

test("the shared native builder cannot select arbitrary projects", async () => {
  await assert.rejects(buildNativePlugin("other_plugin", []), /native_plugin_build_profile_invalid/u);
  await assert.rejects(buildNativePlugin("__proto__", []), /native_plugin_build_profile_invalid/u);
});

test("the writing project-files combination accepts only its finite v2 artifact profile", () => {
  const manifest = {id: "writing_projects", formatVersion: 2, native: {protocolVersion: 2},
    provides: [{id: "writing.project-files", version: 1}, {id: "writing.import-preview", version: 1}]};
  assertWritingProjectNativeBuildManifest(manifest);
  for (const change of [value => {value.native.protocolVersion = 1;}, value => {value.id = "other";},
    value => {value.provides.pop();}, value => {value.provides.push(value.provides[0]);},
    value => {value.provides[0].version = 2;}, value => {value.provides.reverse();}]) {
    const altered = structuredClone(manifest); change(altered);
    assert.throws(() => assertWritingProjectNativeBuildManifest(altered), /writing_native_profile_mismatch/u);
  }
});
