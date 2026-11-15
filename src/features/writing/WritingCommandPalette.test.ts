import { describe, expect, it, vi } from "vitest";

import { filterWritingCommands, type WritingCommand } from "./WritingCommandPalette";

const commands: readonly WritingCommand[] = [
  { id: "compile", label: "编译 PDF", description: "使用本机工具链编译", run: vi.fn() },
  { id: "citation", label: "插入引用", description: "从文献库选择条目", run: vi.fn() },
];

describe("writing command palette", () => {
  it("filters commands by label and description", () => {
    expect(filterWritingCommands(commands, "引用").map((command) => command.id)).toEqual(["citation"]);
    expect(filterWritingCommands(commands, "工具链").map((command) => command.id)).toEqual(["compile"]);
    expect(filterWritingCommands(commands, "  ")).toEqual(commands);
  });
});
