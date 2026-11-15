import { NoteEditorSurface } from "@research-assistant/workbench-sdk/block-content";
import { chooseAppFile } from "@research-assistant/workbench-sdk/platform";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useCreateBlockNote, type DefaultReactSuggestionItem } from "@blocknote/react";
import { blocksToEditor, editorToBlocks, isAllowedNoteHref } from "@research-assistant/core/notes";
import { decodeWritingNote, type WritingNoteFileV1 } from "@research-assistant/writing";
import { blockEditorDefaults } from "@research-assistant/workbench-sdk/block-content";
import { writingNoteSchema, WritingNoteOwner, type WritingNoteEditor, type WritingNotePartialBlock } from "./writingNoteSchema";
import { importWritingNoteAsset } from "./writingNoteAssets";
import "./WritingNotes.css";
import { WritingNoteActivity } from "./WritingNoteActivity";
import {ManagedAssetIngress, type AssetInsertion} from "@research-assistant/workbench-sdk/block-content";
import type {BlockSourceNavigation} from "@research-assistant/workbench-sdk/block-content";
import {openSourceLink} from "@research-assistant/workbench-sdk/source-navigation";
import {withCaptionBlocks, withoutCaptionBlocks} from "@research-assistant/workbench-sdk/block-content";

interface Props {
  readonly content: string;
  readonly manuscriptId: string;
  readonly onChange: (value: string) => void;
  readonly readOnly?: boolean;
  readonly blockSourcePath?: readonly string[];
  readonly sourceNavigation?: BlockSourceNavigation | undefined;
}

export default function WritingNoteEditor(props: Props): React.JSX.Element {
  const decoded = useMemo(() => {
    try { return { document: decodeWritingNote(props.content) }; }
    catch (reason) { return { error: reason instanceof Error ? reason.message : "笔记文件无效" }; }
  }, [props.content]);
  if (!decoded.document) return <div role="alert" className="writing-note-error">无法打开笔记：{decoded.error}。原文件保持不变，请恢复有效版本。</div>;
  return <Session {...props} document={decoded.document} />;
}

function Session({ document, manuscriptId, onChange, readOnly = false, blockSourcePath, sourceNavigation }: Props & { readonly document: WritingNoteFileV1 }): React.JSX.Element {
  const activity = useContext(WritingNoteActivity);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const importing = useRef(false);
  const owner = useRef({manuscriptId, noteId: document.noteId});
  owner.current = {manuscriptId, noteId: document.noteId};
  const [status, setStatus] = useState("");
  const initialContent = useMemo(() => withCaptionBlocks(blocksToEditor(document.blocks)) as WritingNotePartialBlock[], []);
  const editor = useCreateBlockNote({ ...blockEditorDefaults, schema: writingNoteSchema, initialContent, links: {...blockEditorDefaults.links, isValidLink: isAllowedNoteHref} }) as unknown as WritingNoteEditor;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function addAssets(files: readonly File[], insertion: AssetInsertion): Promise<void> {
    if (importing.current || readOnlyRef.current || !alive.current) return;
    importing.current = true;
    const finish = activity?.begin();
    const canInsert = () => alive.current && !readOnlyRef.current && owner.current.manuscriptId === manuscriptId
      && owner.current.noteId === document.noteId;
    setStatus("正在导入附件…");
    try {
      let target = insertion;
      for (const file of files) {
        if (!canInsert()) return;
        const asset = await importWritingNoteAsset(manuscriptId, file);
        const block = editor.getBlock(target.blockId);
        if (!canInsert() || !block) {
          if (alive.current) setStatus("附件已导入；原插入位置已不可编辑，未插入正文。");
          return;
        }
        const value = {type: asset.mimeType.startsWith("image/") ? "managedImage" as const : "managedFile" as const,
          props: {...asset, caption: "", ...(asset.mimeType.startsWith("image/") ? {previewScale: 100} : {})}};
        // Use the current target, not its pre-import text. Typing during the
        // asynchronous file write must never be replaced by the completed image.
        const empty = target.placement === "replaceEmpty" && block.type === "paragraph" && Array.isArray(block.content)
          && !block.content.length && !block.children.length;
        const inserted = empty ? editor.updateBlock(block, value)
          : editor.insertBlocks([value], block, target.placement === "before" ? "before" : "after")[0]!;
        target = {blockId: inserted.id, placement: "after"};
      }
      if (alive.current) setStatus("");
    } catch (reason) { if (alive.current) setStatus(reason instanceof Error ? reason.message : "附件导入失败"); }
    finally { importing.current = false; finish?.(); }
  }
  function addAsset(file: File): Promise<void> {
    return addAssets([file], {blockId: editor.getTextCursorPosition().block.id, placement: "after"});
  }
  const items: DefaultReactSuggestionItem[] = [
    { title: "图片或附件", aliases: ["image", "file", "附件"], group: "写作内容", onItemClick: () => chooseAppFile(input.current, file => void addAsset(file), "asset") },
  ];
  return <WritingNoteOwner.Provider value={manuscriptId}>
    {!readOnly && <input hidden ref={input} type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void addAsset(file); event.target.value = ""; }} />}
    {status && <div role="status">{status}</div>}
    <div className="writing-note-scroll" data-block-editor-scroll-container>
      <NoteEditorSurface editor={editor} readOnly={readOnly} additionalSlashItems={items} ariaLabel="写作笔记正文"
        {...(blockSourcePath ? {blockSourcePath} : {})} sourceNavigation={sourceNavigation}
        onOpenSourceLink={openSourceLink}
        movePolicy={{ maxDepth: 64 }}
        onChange={() => {
          if (readOnlyRef.current) return;
          try {
            const next = JSON.stringify({ schemaVersion: 1, noteId: document.noteId, blocks: editorToBlocks(withoutCaptionBlocks(editor.document)) });
            decodeWritingNote(next);
            activity?.invalid(undefined);
            onChange(next);
          } catch (reason) { const message = reason instanceof Error ? reason.message : "笔记内容无法保存"; setStatus(message); activity?.invalid(message); }
        }}>
        <ManagedAssetIngress editor={editor} onFiles={(files, insertion) => {void addAssets(files, insertion);}} />
      </NoteEditorSurface>
    </div>
  </WritingNoteOwner.Provider>;
}
