import { describe, expect, it } from "vitest";

import { readWritingLayoutPreferences } from "./useWritingLayout";

describe("writing layout preferences", () => {
  it("restores valid preferences and bounds untrusted values", () => {
    expect(readWritingLayoutPreferences({ explorerWidth: 260, previewWidth: 520, narrowPane: "preview" })).toEqual({
      viewMode: "split",
      explorerVisible: true,
      explorerWidth: 260,
      previewWidth: 520,
      narrowPane: "preview",
    });
    expect(readWritingLayoutPreferences({ explorerWidth: -1, previewWidth: 9_999, narrowPane: "unknown" })).toEqual({
      viewMode: "split",
      explorerVisible: true,
      explorerWidth: 160,
      previewWidth: 720,
      narrowPane: "editor",
    });
  });
});
