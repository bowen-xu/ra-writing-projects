import { describe, expect, it } from "vitest";

import { defaultCopyPath } from "./WritingFileConflictDialog";

describe("writing file conflict dialog", () => {
  it("suggests a non-overwriting sibling path", () => {
    expect(defaultCopyPath("main.tex")).toBe("main-conflict-copy.tex");
    expect(defaultCopyPath("sections/method.tex")).toBe("sections/method-conflict-copy.tex");
    expect(defaultCopyPath("LICENSE")).toBe("LICENSE-conflict-copy");
  });
});
