import { createContext, useContext, useEffect, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { baseBlockEditorSchema } from "@research-assistant/workbench-sdk/block-content";
import { exportWritingNoteAsset, readWritingNoteAsset } from "./writingNoteAssets";
import {ImageBlockPresentation, type ImageAlignment} from "@research-assistant/workbench-sdk/block-content";
import type {ImageResizeSource} from "@research-assistant/workbench-sdk/block-content";
import type {MediaBlockEditor} from "@research-assistant/workbench-sdk/block-content";

export const WritingNoteOwner = createContext<string | undefined>(undefined);
const assetProps = { assetId: { default: "" }, displayName: { default: "" }, mimeType: { default: "" }, caption: { default: "" },
  textAlignment: {default: "left", values: ["left", "center", "right"]}, previewScale: {default: 0}, previewWidth: {default: 0} } as const;
function Asset({ assetId, displayName, mimeType, caption, image, textAlignment, onAlignmentChange, previewWidth, previewScale, resize, captionSource }: {
  readonly assetId: string; readonly displayName: string; readonly mimeType: string; readonly caption: string; readonly image: boolean;
  readonly textAlignment?: ImageAlignment;
  readonly onAlignmentChange?: ((alignment: ImageAlignment) => void) | undefined;
  readonly previewWidth?: number | undefined;
  readonly previewScale?: number | undefined;
  readonly resize?: ImageResizeSource | undefined;
  readonly captionSource?: {readonly blockId: string; readonly editor: MediaBlockEditor} | undefined;
}): React.JSX.Element {
  const owner = useContext(WritingNoteOwner);
  const [loaded, setLoaded] = useState<{
    readonly owner: string | undefined; readonly assetId: string; readonly mimeType: string; readonly image: boolean;
    readonly url?: string; readonly error?: string; readonly decodeFailed?: () => void;
  }>();
  const current = loaded?.assetId === assetId && loaded.owner === owner && loaded.mimeType === mimeType && loaded.image === image ? loaded : undefined;
  const [downloadStatus, setDownloadStatus] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    const source = {owner, assetId, mimeType, image};
    const release = () => {
      if (objectUrl !== undefined) {URL.revokeObjectURL(objectUrl); objectUrl = undefined;}
    };
    void (async () => {
      try {
        if (!owner) throw new Error("writing_note_asset_owner_missing：笔记所属稿件不可用。");
        const bytes = await readWritingNoteAsset(owner, assetId);
        if (!active) return;
        const safeMime = /^image\/(png|jpeg|gif|webp)$/.test(mimeType) ? mimeType : "application/octet-stream";
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], {type: safeMime}));
        setLoaded({...source, url: objectUrl, decodeFailed: () => {
          if (!active || objectUrl === undefined) return;
          release();
          setLoaded({...source, error: "writing_note_asset_decode_failed：图片无法显示，请检查格式或重新插入。"});
        }});
      } catch (reason) {
        if (!active) return;
        const code = reason && typeof reason === "object" && "code" in reason && typeof reason.code === "string" ? reason.code : undefined;
        const message = reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string" ? reason.message : String(reason);
        setLoaded({...source, error: `writing_note_asset_read_failed：${code ? `${code}：` : ""}${message}`});
      }
    })();
    return () => {active = false; release();};
  }, [owner, assetId, mimeType, image]);
  if (image) return <ImageBlockPresentation className="writing-note-asset" assetId={assetId}
    src={current?.url && /^image\/(png|jpeg|gif|webp)$/.test(mimeType) ? current.url : undefined}
    alt={caption || "图片"} caption={caption} alignment={textAlignment ?? "left"} error={current?.error}
    onError={current?.decodeFailed}
    onAlignmentChange={onAlignmentChange} previewWidth={previewWidth || undefined} previewScale={previewScale} resize={resize} captionSource={captionSource}/>;
  return <figure className="writing-note-asset" contentEditable={false}>
    <figcaption>{displayName}{caption && <small>{caption}</small>}</figcaption>
    {downloadStatus && <span role="status">{downloadStatus}</span>}
    {current?.error ? <span role="alert">{current.error}</span> : current?.url && <button type="button" onClick={() => { if (owner) void exportWritingNoteAsset(owner, assetId, displayName).then((path) => setDownloadStatus("已下载：" + path)).catch((reason: unknown) => setDownloadStatus(reason instanceof Error ? reason.message : "下载失败")); }}>下载附件</button>}
  </figure>;
}
const managedImage = createReactBlockSpec({ type: "managedImage", propSchema: assetProps, content: "none" }, {
  render: ({ block, editor }) => <Asset {...block.props} image captionSource={{blockId: block.id, editor}}
    onAlignmentChange={textAlignment => {if (editor.isEditable) editor.updateBlock(block.id, {props: {textAlignment}});}}
  resize={{blockId: block.id, editor, onScaleChange: previewScale => {
    if (editor.isEditable && editor.getBlock(block.id)) editor.updateBlock(block.id, {props: {previewScale, previewWidth: 0}});
  }}} />,
});
const managedFile = createReactBlockSpec({ type: "managedFile", propSchema: assetProps, content: "none" }, {
  render: ({ block }) => <Asset {...block.props} image={false} />,
});
export const writingNoteSchema = baseBlockEditorSchema.extend({
  blockSpecs: { managedImage: managedImage(), managedFile: managedFile() },
});
export type WritingNoteEditor = typeof writingNoteSchema.BlockNoteEditor;
export type WritingNotePartialBlock = typeof writingNoteSchema.PartialBlock;
