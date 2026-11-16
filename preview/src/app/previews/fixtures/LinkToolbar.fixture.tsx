import {StrictMode, useState} from "react";
import {createRoot} from "react-dom/client";
import {noteBlockId, notePageId, type NoteBlockV1, type NoteDocumentV1} from "@research-assistant/core/notes";
import {NoteEditor} from "@research-assistant/workbench-preview/note-editor";
import WritingNoteEditor from "../../../../../src/features/writing/notes/WritingNoteEditor";
import {NotesProvider} from "@research-assistant/workbench-preview/notes-client";
import {noteRendererGateway} from "@research-assistant/workbench-preview/note-gateway";

/** Synthetic data and lifecycle only; both hosts use their production editor. */
export function mountLinkToolbarFixture(): void {
  const link = (text: string, href = "https://example.org/one") => ({type: "link" as const, href,
    content: [{type: "text" as const, text, styles: []}]});
  const blocks: NoteBlockV1[] = [
    {id: noteBlockId("body"), type: "paragraph", props: {}, children: [], content: {kind: "inline", items: [
      {type: "text", text: "Before ", styles: []}, link("3"), {type: "text", text: " after ", styles: []}, link("Long link"),
    ]}},
    {id: noteBlockId("table"), type: "table", props: {}, children: [], content: {kind: "table", rows: [[
      {kind: "inline", items: [link("3")]}, {kind: "inline", items: [{type: "link", href: "https://example.org/format", content: [
        {type: "text", text: "Bold", styles: ["bold"]}, {type: "text", text: "plain", styles: []},
      ]}]},
    ]]}},
    {id: noteBlockId("tail"), type: "paragraph", props: {}, children: [], content: {kind: "inline", items: [
      {type: "text", text: "Outside link", styles: []},
    ]}},
  ];
  function Host({writing}: {writing: boolean}) {
    const [document, setDocument] = useState<NoteDocumentV1>({schemaVersion: 1, pageId: notePageId("hover"), blocks});
    const [content, setContent] = useState(JSON.stringify({schemaVersion: 1, noteId: "hover", blocks}));
    const [readOnly, setReadOnly] = useState(false);
    return <section aria-label={writing ? "写作笔记" : "普通笔记"} style={{minWidth: 0, background: "white", padding: 20}}>
      <h2>{writing ? "写作笔记" : "普通笔记"}</h2>
      <button onClick={() => setReadOnly(!readOnly)}>{readOnly ? "切换编辑" : "切换只读"}</button>
      {writing ? <WritingNoteEditor manuscriptId="fixture" content={content} onChange={setContent} readOnly={readOnly}/>
        : <NoteEditor document={document} onChange={setDocument} isReadOnly={readOnly}/>}
    </section>;
  }
  const target = document.createElement("div");
  Object.assign(target.style, {position: "fixed", inset: "0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", padding: "20px", background: "#eee", overflow: "auto"});
  document.body.replaceChildren(target);
  createRoot(target).render(<StrictMode><NotesProvider gateway={noteRendererGateway}><Host writing={false}/><Host writing/></NotesProvider></StrictMode>);
}
