// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createWritingNote } from "@research-assistant/writing";
import WritingNoteEditor from "./WritingNoteEditor";

it("embeds the shared note surface without a toolbar or NotesClient and retains the editor on save echoes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), onChange = vi.fn();
  const content = JSON.stringify(createWritingNote("note", "block"));
  try {
    await act(async () => root.render(<WritingNoteEditor manuscriptId="m" content={content} onChange={onChange} />));
    const editor = host.querySelector(".bn-editor");
    expect(editor).not.toBeNull();
    expect(editor?.closest(".note-editor-surface")).not.toBeNull();
    expect(host.querySelector('[role="toolbar"][aria-label="笔记编辑工具"]')).toBeNull();
    expect(host.querySelector('input[type="file"]')).not.toBeNull();
    const saved = onChange.mock.lastCall?.[0] as string | undefined;
    onChange.mockClear();
    await act(async () => root.render(<WritingNoteEditor manuscriptId="m" content={saved ?? content} onChange={onChange} readOnly />));
    expect(host.querySelector(".bn-editor")).toBe(editor);
    expect(editor?.getAttribute("contenteditable")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
