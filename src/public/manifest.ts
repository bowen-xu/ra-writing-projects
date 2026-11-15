import type {BuiltinPluginManifest} from "@research-assistant/workbench-sdk";

/** Pure build and application declaration; importing it cannot load the workspace. */
export const writingProjectsManifest = {
  id: "writing_projects",
  apiVersion: 1,
  dependencies: { required: [], optional: [{ id: "literature_library", apiVersion: 1 }] },
  provides: [{ id: "writing.projects", version: 1 }, { id: "writing.note-catalog", version: 1 }],
  consumes: {
    required: ["core.workbench", "core.workbench.writing-frontend", "core.workbench.writing-runtime", "core.notes", "core.editor", "core.hbs", "core.agent", "core.agent.tools", "core.agent.writing-dispatch-admission", "core.agent.writing-compaction-retirement", "core.resources", "core.pdf", "core.models", "core.git", "core.platform"]
      .map(id => ({ id, version: 1, provider: "core" })),
    optional: [{ id: "literature.citations", version: 1, provider: "literature_library" },
      ...["core.agent.skills", "core.agent.mcp"].map(id => ({id, version: 1, provider: "core"}))],
  },
} as const satisfies BuiltinPluginManifest;
