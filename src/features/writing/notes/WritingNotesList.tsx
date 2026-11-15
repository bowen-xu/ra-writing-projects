import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { ExplorerCreateSlot } from "../explorer/ExplorerCreateSlot";
import { useNotificationState } from "@research-assistant/workbench-sdk/feedback";
import { isWritingNotePath, parseManuscriptPath, writingNotePath, writingNoteTitle, type ManuscriptFile, type ManuscriptDirectory } from "@research-assistant/writing";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, MoreVertical } from "lucide-react";
import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import { WritingMenu, WritingMenuItem } from "../WritingMenu";

export interface WritingNotesActions { createNote(): void; createDirectory(): void }
interface Props {
  readonly files: readonly ManuscriptFile[];
  readonly directories: readonly ManuscriptDirectory[];
  readonly activePath: string | undefined;
  readonly actionsRef?: Ref<WritingNotesActions>;
  readonly onSelectFile: (path: string) => void;
  readonly onPinFile?: (path: string) => void;
  readonly onCreateFile: (path: string) => void;
  readonly onRenameFile: (from: string, to: string) => void;
  readonly onDeleteFile: (path: string) => void;
  readonly onCreateDirectory: (path: string) => void;
  readonly onRenameDirectory: (from: string, to: string) => void;
  readonly onDeleteDirectory: (path: string) => void;
}
export function WritingNotesList(props: Props): React.JSX.Element {
  const [editing, setEditing] = useState<{ kind: "note" | "directory"; from?: string; parent: string }>();
  const [title, setTitle] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("notes");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [, setError] = useNotificationState("error");
  const notes = props.files.filter(file => isWritingNotePath(file.relativePath));
  const directories = new Set(props.directories.filter(directory => directory.relativePath.startsWith("notes/")).map(directory => String(directory.relativePath)));
  for (const note of notes) {
    const parts = note.relativePath.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  directories.delete("notes");
  useEffect(() => { if (selectedFolder !== "notes" && !directories.has(selectedFolder)) setSelectedFolder("notes"); }, [props.files, props.directories, selectedFolder]);
  function begin(kind: "note" | "directory", from?: string): void {
    setEditing({ kind, ...(from ? { from } : {}), parent: from ? from.split("/").slice(0, -1).join("/") : selectedFolder });
    setCollapsed(current => { const next = new Set(current); next.delete(selectedFolder); return next; });
    setTitle(from ? kind === "note" ? writingNoteTitle(from) : from.split("/").at(-1) ?? "" : ""); setError("");
  }
  useImperativeHandle(props.actionsRef, () => ({ createNote: () => begin("note"), createDirectory: () => begin("directory") }));
  function submit(): void {
    if (!editing) return;
    try {
      const name = editing.kind === "note" ? writingNotePath(title).split("/").at(-1)! : title.trim();
      if (!name || /[/\\]/.test(name)) throw new Error("文件夹名称不能包含路径分隔符");
      const path = parseManuscriptPath(editing.parent ? `${editing.parent}/${name}` : name);
      if (props.files.some(file => file.relativePath === path && file.relativePath !== editing.from) || props.directories.some(directory => directory.relativePath === path && directory.relativePath !== editing.from)) throw new Error("已存在同名笔记或文件夹");
      if (editing.kind === "note") {
        if (editing.from) props.onRenameFile(editing.from, path); else props.onCreateFile(path);
      } else if (editing.from) props.onRenameDirectory(editing.from, path); else props.onCreateDirectory(path);
      setCollapsed(current => { const next = new Set(current); next.delete(editing.parent); return next; });
      setEditing(undefined); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "笔记名称无效"); }
  }
  function entries(parent: string, depth: number): React.JSX.Element {
    const belongs = (value: string) => value.split("/").slice(0, -1).join("/") === parent;
    const slot = editing && !editing.from && editing.parent === parent ? <ExplorerCreateSlot key="create-slot" kind={editing.kind} label={editing.kind === "note" ? "笔记名称" : "笔记文件夹名称"} value={title} depth={depth} onChange={setTitle} onSubmit={submit} onCancel={() => setEditing(undefined)} /> : null;
    const folderRows: (string | null)[] = [...directories].filter(belongs);
    const noteRows: (ManuscriptFile | null)[] = notes.filter(file => belongs(file.relativePath));
    if (slot) (editing?.kind === "directory" ? folderRows : noteRows).push(null);
    folderRows.sort((a, b) => (a?.split("/").at(-1) ?? title).localeCompare(b?.split("/").at(-1) ?? title));
    noteRows.sort((a, b) => (a ? writingNoteTitle(a.relativePath) : title).localeCompare(b ? writingNoteTitle(b.relativePath) : title));
    return <>
      {folderRows.map(directory => {
        if (directory === null) return slot;
        const closed = collapsed.has(directory);
        return <div key={directory}>
          <div className="writing-file-row directory" style={{ paddingLeft: depth * 14 }}>
            <ControlHint content={directory}><button type="button" aria-label={directory} aria-expanded={!closed} onClick={() => { setSelectedFolder(directory); setCollapsed(current => { const next = new Set(current); next.has(directory) ? next.delete(directory) : next.add(directory); return next; }); }}>{closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{closed ? <Folder size={16} /> : <FolderOpen size={16} />}<span>{directory.split("/").at(-1)}</span></button></ControlHint>
            <WritingMenu className="writing-file-menu" contentClassName="writing-file-options" label={`笔记文件夹操作 ${directory}`} trigger={<MoreVertical size={16} />}><WritingMenuItem onClick={() => begin("directory", directory)}>重命名目录</WritingMenuItem><WritingMenuItem onClick={() => props.onDeleteDirectory(directory)}>删除目录</WritingMenuItem></WritingMenu>
          </div>{!closed && entries(directory, depth + 1)}
        </div>;
      })}
      {noteRows.map(file => file === null ? slot : <div key={file.relativePath} className={`writing-file-row ${file.relativePath === props.activePath ? "active" : ""}`} style={{ paddingLeft: 14 + depth * 14 }}>
        <ControlHint content={file.relativePath}><button aria-label={file.relativePath} type="button" aria-current={file.relativePath === props.activePath ? "page" : undefined} onClick={() => { setSelectedFolder(file.relativePath.split("/").slice(0, -1).join("/") || "notes"); props.onSelectFile(file.relativePath); }} onDoubleClick={() => props.onPinFile?.(file.relativePath)}><FileText size={17} /><span>{writingNoteTitle(file.relativePath)}</span></button></ControlHint>
        <WritingMenu className="writing-file-menu" contentClassName="writing-file-options" label={`笔记操作 ${writingNoteTitle(file.relativePath)}`} trigger={<MoreVertical size={16} />}><WritingMenuItem onClick={() => begin("note", file.relativePath)}>重命名</WritingMenuItem><WritingMenuItem onClick={() => props.onDeleteFile(file.relativePath)}>删除</WritingMenuItem></WritingMenu>
      </div>)}
    </>;
  }
  return <section className="writing-notes-list" aria-label="写作笔记" onClick={event => { if (!(event.target as HTMLElement).closest(".writing-file-row, form, button")) setSelectedFolder("notes"); }}>
    {editing?.from && <form className="writing-file-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label>{editing.kind === "note" ? "笔记名称" : "笔记文件夹名称"}<input autoFocus aria-label={editing.kind === "note" ? "笔记名称" : "笔记文件夹名称"} value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setEditing(undefined); }} /></label>
      <div><button type="submit" disabled={!title.trim()}>确定</button><button type="button" onClick={() => setEditing(undefined)}>取消</button></div>
    </form>}
    {!editing && notes.length === 0 && directories.size === 0 && <p className="writing-notes-empty">记录写作思路</p>}
    {entries("notes", 0)}{entries("", 0)}
  </section>;
}
