import { useId, useState } from "react";
import { Pencil, Save, Trash2 } from "lucide-react";
import { decodeWritingNote, writingNoteTitle } from "@research-assistant/writing";
import { ActionMenuItem } from "@research-assistant/workbench-sdk/overlay";
import { NotePageToolbar } from "@research-assistant/workbench-sdk/note-documents";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import type { SaveState } from "../workspaceState";

interface Props {
  readonly manuscriptId: string;
  readonly path: string;
  readonly content: string;
  readonly saveState: SaveState;
  readonly onSave?: () => void;
  readonly onRename?: (from: string, to: string) => void;
  readonly onDelete?: (path: string) => void;
}

export function WritingNoteToolbar(props: Props): React.JSX.Element {
  let noteId = props.path;
  try { noteId = decodeWritingNote(props.content).noteId; } catch { /* A damaged note remains available for recovery. */ }
  return <Toolbar key={JSON.stringify([props.manuscriptId, noteId])} {...props} noteId={noteId} />;
}

function Toolbar(props: Props & { readonly noteId: string }): React.JSX.Element {
  const propertiesId = useId();
  const [showProperties, setShowProperties] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(writingNoteTitle(props.path));
  function rename(): void {
    const title = name.trim();
    if (!title || /[/\\]/.test(title)) { notify.error("笔记名称不能为空或包含路径分隔符"); return; }
    const parent = props.path.split("/").slice(0, -1).join("/");
    const path = `${parent ? parent + "/" : ""}${title}.ranote`;
    if (path !== props.path) props.onRename?.(props.path, path);
    setRenaming(false);
  }
  return <div className="writing-note-page-actions">
    <NotePageToolbar canFavorite={false} saveStatus={props.saveState === "error" ? "failed" : props.saveState} saveMessage={undefined} favorite={false}
      onFavoriteChange={() => undefined}
      propertiesId={propertiesId} showProperties={showProperties} onToggleProperties={() => setShowProperties(value => !value)}>
      {props.onSave && <ActionMenuItem onClick={props.onSave}><Save size={16} />保存笔记</ActionMenuItem>}
      {props.onRename && <ActionMenuItem onClick={() => { setName(writingNoteTitle(props.path)); setShowProperties(true); setRenaming(true); }}><Pencil size={16} />重命名</ActionMenuItem>}
      {props.onDelete && <ActionMenuItem className="danger-text" onClick={() => props.onDelete?.(props.path)}><Trash2 size={16} />删除笔记</ActionMenuItem>}
    </NotePageToolbar>
    {showProperties && <section id={propertiesId} aria-label="页面属性" className="writing-note-properties">
      <dl><dt>路径</dt><dd>{props.path}</dd><dt>格式</dt><dd>写作块笔记（.ranote）</dd></dl>
      {renaming && <form onSubmit={event => { event.preventDefault(); rename(); }}><label>笔记名称<input autoFocus aria-label="重命名笔记" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setRenaming(false); }} /></label><button type="submit">确定</button></form>}
    </section>}
  </div>;
}
