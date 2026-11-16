// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {createWritingNote} from "@research-assistant/writing";
import WritingNoteEditor from "@research-assistant/writing-projects-preview/writing-note-editor";
import {SOURCE_NAVIGATION_EVENT, type SourceNavigationRequest} from "@research-assistant/workbench-preview/source-navigation";

it("injects writing identity and navigation into the shared note surface without a NotesClient", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const onChange = vi.fn(), onLocated = vi.fn(), onError = vi.fn();
  const note = createWritingNote("note", "writing-block");
  const href = "source://writings/project/notes/idea.ranote:#block{writing-block}";
  const content = JSON.stringify({...note, blocks: [{...note.blocks[0]!, content: {kind: "inline", items: [
    {type: "link", href, content: [{type: "text", text: "回到写作笔记块", styles: []}]},
  ]}}]});
  const requested = vi.fn((event: Event) => {event.preventDefault(); (event as CustomEvent<SourceNavigationRequest>).detail.resolve();});
  window.addEventListener(SOURCE_NAVIGATION_EVENT, requested);
  try {
    await act(async () => root.render(<WritingNoteEditor manuscriptId="project" content={content} onChange={onChange}
      blockSourcePath={["writings", "project", "notes", "idea.ranote"]}
      sourceNavigation={{blockId: "writing-block", token: 1, onLocated, onError}}/>));
    await act(async () => {await vi.waitFor(() => expect(onLocated).toHaveBeenCalledOnce());});
    expect(onError).not.toHaveBeenCalled();
    expect(host.querySelector('.note-editor-surface [data-id="writing-block"]')).not.toBeNull();
    expect(onLocated.mock.calls[0]![0].getAnchorRect()).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    const anchor = host.querySelector("a")!, event = new MouseEvent("click", {bubbles: true, cancelable: true});
    await act(async () => anchor.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true); expect(requested).toHaveBeenCalledOnce();
    expect((requested.mock.calls[0]![0] as CustomEvent<SourceNavigationRequest>).detail.link).toMatchObject({path: ["writings", "project", "notes", "idea.ranote"], locator: {kind: "block", blockId: "writing-block"}});
  } finally {window.removeEventListener(SOURCE_NAVIGATION_EVENT, requested); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();}
});
