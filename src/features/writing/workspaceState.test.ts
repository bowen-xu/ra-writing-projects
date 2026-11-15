import { describe, expect, it } from "vitest";

import { errorCode, errorMessage, readAutoCompile, readCursorOffsets } from "./workspaceState";

describe("writing workspace state", () => {
  it("restores auto compile only from an explicit true preference", () => {
    expect(readAutoCompile({ autoCompile: true })).toBe(true);
    expect(readAutoCompile({ autoCompile: false })).toBe(false);
    expect(readAutoCompile({ autoCompile: "true" })).toBe(false);
    expect(readAutoCompile(null)).toBe(false);
  });

  it("keeps only numeric cursor offsets from persisted input", () => {
    expect(readCursorOffsets({ "main.tex": 21, "bad.tex": "9" })).toEqual({
      "main.tex": 21,
    });
    expect(readCursorOffsets([])).toEqual({});
  });

  it("preserves structured Tauri command errors", () => {
    const failure = { code: "file_conflict", message: "文件已在其他位置被修改" };
    expect(errorCode(failure)).toBe("file_conflict");
    expect(errorMessage(failure)).toBe("文件已在其他位置被修改");
    expect(errorMessage(new Error("普通错误"))).toBe("普通错误");
  });
});
