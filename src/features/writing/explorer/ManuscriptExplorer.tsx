import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { ExplorerCreateSlot } from "./ExplorerCreateSlot";
import { isWritingSourcePath, isWritingNoteAssetPath, isWritingNotePath } from "@research-assistant/writing";
import { WritingNotesList, type WritingNotesActions } from "../notes/WritingNotesList";
import type { LatexOutlineEntry, ManuscriptDirectory, ManuscriptFile } from "@research-assistant/writing";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { BookOpen, ChevronDown, ChevronRight, FileCode2, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, Image, MoreVertical, X } from "lucide-react";
import { WritingMenu, WritingMenuItem } from "../WritingMenu";
import { OutlinePanel } from "./OutlinePanel";
import {useWorkspaceState, workspaceStringSet} from "@research-assistant/workbench-sdk/workspace-state";
import {usePluginSetting} from "@research-assistant/workbench-sdk/configuration-hooks";
import {writingOutlineSetting} from "../../../public/configuration";

interface ManuscriptExplorerProps {
  readonly manuscriptId?: string | undefined;
  readonly activeNotePath?: string | undefined;
  readonly files: readonly ManuscriptFile[];
  readonly directories: readonly ManuscriptDirectory[];
  readonly activePath: string | undefined;
  readonly rootPath: string | undefined;
  readonly onSelectFile: (path: string) => void;
  readonly onPinFile?: (path: string) => void;
  readonly onCreateFile: (path: string) => void;
  readonly onRenameFile: (fromPath: string, toPath: string) => void;
  readonly onDeleteFile: (path: string) => void;
  readonly onSetRoot: (path: string) => void;
  readonly onCreateDirectory: (path: string) => void;
  readonly onRenameDirectory: (fromPath: string, toPath: string) => void;
  readonly onDeleteDirectory: (path: string) => void;
  readonly outline: readonly LatexOutlineEntry[];
  readonly onSelectOutline: (entry: LatexOutlineEntry) => void;
}

type EntryEdit = { readonly kind: "file" | "directory"; readonly from?: string; readonly parent?: string };

export function ManuscriptExplorer(props: ManuscriptExplorerProps): React.JSX.Element {
  const [tab, setTab] = useState<"files" | "notes">(() => isWritingNotePath(props.activePath) ? "notes" : "files");
  const notesActions = useRef<WritingNotesActions>(null);
  useEffect(() => { if (props.activePath) setTab(isWritingNotePath(props.activePath) ? "notes" : "files"); }, [props.activePath]);
  const [collapsed, setCollapsed] = useWorkspaceState(`writing-folders:${props.manuscriptId ?? "standalone"}`,new Set<string>() as ReadonlySet<string>,workspaceStringSet,!!props.manuscriptId);
  const [edit, setEdit] = useState<EntryEdit>();
  const [selectedFolder, setSelectedFolder] = useState("");
  const [path, setPath] = useState("");
  const [outlineVisible, setOutlineVisible] = usePluginSetting(writingOutlineSetting, {enabled: !!props.manuscriptId, ...(props.manuscriptId === undefined ? {} : {resourceId: props.manuscriptId})});
  const sourceFiles = props.files.filter((file) => isWritingSourcePath(file.relativePath));
  const visibleDirectories = props.directories.filter((directory) => !isWritingNoteAssetPath(directory.relativePath) && directory.relativePath !== "notes" && !directory.relativePath.startsWith("notes/")
    && !(props.files.some((file) => file.relativePath.startsWith(directory.relativePath + "/"))
      && !sourceFiles.some((file) => file.relativePath.startsWith(directory.relativePath + "/"))));
  const directories = new Set(visibleDirectories.map((item) => item.relativePath as string));
  for (const item of [...sourceFiles, ...visibleDirectories]) {
    const parts = item.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  function startEdit(value: EntryEdit): void { const parent = value.from ? undefined : selectedFolder; setEdit({ ...value, ...(parent !== undefined ? { parent } : {}) }); setPath(value.from ?? ""); if (parent) setCollapsed(current => { const next = new Set(current); next.delete(parent); return next; }); }
  function submit(): void {
    const next = edit?.parent ? `${edit.parent}/${path.trim()}` : path.trim();
    if (!next || !edit) return;
    if (edit.from) {
      if (next !== edit.from) (edit.kind === "file" ? props.onRenameFile : props.onRenameDirectory)(edit.from, next);
    } else (edit.kind === "file" ? props.onCreateFile : props.onCreateDirectory)(next);
    setEdit(undefined);
  }
  function entries(parent: string, depth: number): React.JSX.Element {
    const belongs = (value: string): boolean => value.split("/").slice(0, -1).join("/") === parent;
    return <>
      {edit && !edit.from && edit.parent === parent && <ExplorerCreateSlot kind={edit.kind} label="工程相对路径" value={path} depth={depth} onChange={setPath} onSubmit={submit} onCancel={() => setEdit(undefined)} />}
      {[...directories].filter(belongs).sort().map((directory) => {
        const closed = collapsed.has(directory);
        return <div key={directory}>
          <div className="writing-file-row directory" draggable onDragStart={(event) => writeDraggedEntry(event, "directory", directory)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveDroppedEntry(event, directory, props)} style={{ paddingLeft: depth * 14 }}>
            <ControlHint content={directory}><button aria-label={directory} aria-expanded={!closed} onClick={() => { setSelectedFolder(directory); setCollapsed((current) => { const next = new Set(current); next.has(directory) ? next.delete(directory) : next.add(directory); return next; }); }} type="button">{closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{closed ? <Folder size={16} /> : <FolderOpen size={16} />}<span>{directory.split("/").at(-1)}</span></button></ControlHint>
            <WritingMenu className="writing-file-menu" contentClassName="writing-file-options" label={"目录操作 " + directory} trigger={<MoreVertical size={16} />}><WritingMenuItem onClick={() => startEdit({ kind: "directory", from: directory })} type="button">重命名目录</WritingMenuItem><WritingMenuItem onClick={() => props.onDeleteDirectory(directory)} type="button">删除目录</WritingMenuItem></WritingMenu>
          </div>
          {!closed && entries(directory, depth + 1)}
        </div>;
      })}
      {sourceFiles.filter((file) => belongs(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map((file) => {
        const Icon = file.kind === "bib" ? BookOpen : file.kind === "image" ? Image : file.kind === "tex" ? FileCode2 : FileText;
        return <div className={"writing-file-row " + (file.relativePath === props.activePath ? "active" : "")} key={file.relativePath} draggable={file.kind !== "bib"} onDragStart={(event) => writeDraggedEntry(event, "file", file.relativePath)} style={{ paddingLeft: 14 + depth * 14 }}>
          <ControlHint content={file.kind === "image" ? file.relativePath + "（图片资源）" : file.relativePath}><button aria-label={file.relativePath} aria-current={file.relativePath === props.activePath ? "page" : undefined} disabled={file.kind === "image"} onClick={() => { setSelectedFolder(file.relativePath.split("/").slice(0, -1).join("/")); props.onSelectFile(file.relativePath); }} onDoubleClick={() => props.onPinFile?.(file.relativePath)} type="button"><Icon size={17} /><span>{file.relativePath.split("/").at(-1)}</span>{file.relativePath === props.rootPath && <small>主</small>}</button></ControlHint>
          {file.kind !== "bib" && <WritingMenu className="writing-file-menu" contentClassName="writing-file-options" label={"文件操作 " + file.relativePath} trigger={<MoreVertical size={16} />}>{file.kind === "tex" && <WritingMenuItem onClick={() => props.onSetRoot(file.relativePath)} type="button">{file.relativePath === props.rootPath ? "当前主文档" : "设为主文档"}</WritingMenuItem>}<WritingMenuItem onClick={() => startEdit({ kind: "file", from: file.relativePath })} type="button">重命名</WritingMenuItem><WritingMenuItem onClick={() => props.onDeleteFile(file.relativePath)} type="button">删除</WritingMenuItem></WritingMenu>}
        </div>;
      })}
    </>;
  }
  return <aside className="writing-explorer" aria-label="稿件工程">
    <div className="writing-explorer-heading">
      <div className="writing-explorer-tabs" role="tablist" aria-label="稿件资源类型">{(["files", "notes"] as const).map(value => <button type="button" role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} id={`writing-explorer-tab-${value}`} aria-controls={`writing-explorer-panel-${value}`} key={value} onClick={() => setTab(value)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "files" : event.key === "End" ? "notes" : value === "files" ? "notes" : "files"; setTab(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#writing-explorer-tab-${next}`)?.focus(); } }}>{value === "files" ? "文件" : "笔记"}</button>)}</div>
      <div className="writing-explorer-actions">
        <ControlHint content={tab === "files" ? "新建文件" : "新建笔记"}><button aria-label={tab === "files" ? "新建文件" : "新建笔记"} onClick={() => tab === "files" ? startEdit({ kind: "file" }) : notesActions.current?.createNote()} type="button"><FilePlus2 size={17} /></button></ControlHint>
        <ControlHint content={tab === "files" ? "新建目录" : "新建笔记文件夹"}><button aria-label={tab === "files" ? "新建目录" : "新建笔记文件夹"} onClick={() => tab === "files" ? startEdit({ kind: "directory" }) : notesActions.current?.createDirectory()} type="button"><FolderPlus size={17} /></button></ControlHint>
      </div>
    </div>
    {tab === "files" && edit?.from && <form className="writing-file-form" onSubmit={(event) => { event.preventDefault(); submit(); }}><label>{edit.from ? "重命名" : edit.kind === "file" ? "新建文件" : "新建目录"}<input autoFocus aria-label="工程相对路径" value={path} placeholder={edit.kind === "file" ? "sections/method.tex" : "figures"} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEdit(undefined); }} /></label><div><button type="submit" disabled={!path.trim()}>确定</button><button aria-label="取消文件操作" onClick={() => setEdit(undefined)} type="button"><X size={14} /></button></div></form>}
    <div className="writing-file-tree" onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveDroppedEntry(event, "", props)}><div role="tabpanel" id="writing-explorer-panel-files" aria-labelledby="writing-explorer-tab-files" hidden={tab !== "files"} onClick={event => { if (!(event.target as HTMLElement).closest(".writing-file-row, form, button")) setSelectedFolder(""); }}>{entries("", 0)}</div><div role="tabpanel" id="writing-explorer-panel-notes" aria-labelledby="writing-explorer-tab-notes" hidden={tab !== "notes"}><WritingNotesList {...props} activePath={props.activeNotePath ?? props.activePath} actionsRef={notesActions} /></div></div>
    <button className="writing-outline-toggle" aria-expanded={outlineVisible} onClick={() => setOutlineVisible(!outlineVisible)} type="button">{outlineVisible ? <ChevronDown size={16} /> : <ChevronRight size={16} />}文档大纲</button>
    {outlineVisible && <OutlinePanel entries={props.outline} onSelect={props.onSelectOutline} />}

  </aside>;
}

type DragEntryKind = "file" | "directory";

function writeDraggedEntry(event: DragEvent, kind: DragEntryKind, path: string): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-research-assistant-manuscript", JSON.stringify({ kind, path }));
}

function moveDroppedEntry(
  event: DragEvent,
  destinationDirectory: string,
  props: ManuscriptExplorerProps,
): void {
  event.preventDefault();
  event.stopPropagation();
  const raw = event.dataTransfer.getData("application/x-research-assistant-manuscript");
  if (!raw) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isDragEntry(value) || /\.bib$/iu.test(value.path)) return;
    const name = value.path.split("/").at(-1);
    if (!name) return;
    const destination = destinationDirectory ? `${destinationDirectory}/${name}` : name;
    if (destination === value.path) return;
    if (value.kind === "file") props.onRenameFile(value.path, destination);
    else props.onRenameDirectory(value.path, destination);
  } catch {
    // Ignore drag data from outside this manuscript tree.
  }
}

function isDragEntry(value: unknown): value is { readonly kind: DragEntryKind; readonly path: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.kind === "file" || record.kind === "directory") && typeof record.path === "string";
}
