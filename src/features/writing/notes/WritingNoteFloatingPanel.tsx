import { lazy, Suspense, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { NoteFloatingWindow } from "@research-assistant/workbench-sdk/document-windows";
import { decodeWritingNote, writingNoteTitle, type ManuscriptFile } from "@research-assistant/writing";
import type { WritingGateway } from "../gateway";
import { useWritingPersistence } from "../useWritingPersistence";
import { useWritingFileConflict } from "../useWritingFileConflict";
import { WritingFileConflictDialog } from "../editor/WritingFileConflictDialog";
import { useWritingNoteActivity, WritingNoteActivity } from "./WritingNoteActivity";
import { WritingNoteToolbar } from "./WritingNoteToolbar";
import { getReaderCloseCoordinator } from "@research-assistant/workbench-sdk/workbench";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import type { SaveState } from "../workspaceState";
import "./WritingNotes.css";
const WritingNoteEditor = lazy(() => import("./WritingNoteEditor"));
export interface WritingNoteWindowTarget { readonly manuscriptId: string; readonly path: string; readonly token: string }
export interface WritingNoteWindowPort { prepareClose(): Promise<boolean> }

/** A persistent auxiliary file host. Same editor, save queue, CAS, recovery and
 * conflict UI as writing; it never overwrites the manuscript's tab/layout state. */
export function WritingNoteFloatingPanel({ target, gateway, onClose, onExpand, onFilesChanged, windowRef }: {
  readonly target: WritingNoteWindowTarget; readonly gateway: WritingGateway;
  readonly onClose: () => void; readonly onExpand: (target: WritingNoteWindowTarget) => Promise<boolean>;
  readonly onFilesChanged: (manuscriptId: string, files: readonly ManuscriptFile[]) => void;
  readonly windowRef: Ref<WritingNoteWindowPort>;
}): React.JSX.Element {
  const [path, setPath] = useState<string | undefined>(undefined), [content, setContent] = useState("");
  const [hash, setHash] = useState<string>(), [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string>(), [openPaths, setOpenPaths] = useState<readonly string[]>([]);
  const [files, setFiles] = useState<readonly ManuscriptFile[]>([]);
  const filesChanged = useRef(onFilesChanged); filesChanged.current = onFilesChanged;
  const [session, setSession] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const showError = setError;
  useEffect(() => { if (error) notify.error(error); }, [error]);
  const conflicts = useWritingFileConflict({ gateway, setActivePath: setPath, setContent, setContentHash: setHash, setError: showError, setFiles, setOpenPaths, setSaveState });
  const persistence = useWritingPersistence({ persistWorkspaceSession: false,
    activeManuscriptId: path ? target.manuscriptId : undefined, activePath: path, content, contentHash: hash,
    cursorOffsets: {}, gateway, openPaths, layoutState: {}, onFileConflict: conflicts.onConflict, saveState,
    setContentHash: setHash, setError: showError, setFiles, setSaveState });
  const activity = useWritingNoteActivity(persistence, showError);
  useImperativeHandle(windowRef, () => ({ prepareClose: activity.saveCurrent }), [activity.saveCurrent]);
  useEffect(() => getReaderCloseCoordinator().register(`writing-note-window:${target.token}`, {
    isActive: () => !!panel.current?.contains(document.activeElement), prepare: activity.saveCurrent, commit: onClose,
  }), [target.token, activity.saveCurrent, onClose]);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [file, drafts] = await Promise.all([gateway.readFile(target.manuscriptId, target.path), gateway.listRecoveryDrafts(target.manuscriptId)]);
        if (!current) return;
        decodeWritingNote(file.content);
        const draft = drafts.find(value => value.relativePath === target.path);
        if (draft) decodeWritingNote(draft.content);
        setContent(draft?.content ?? file.content); setHash(file.sha256); setPath(file.relativePath); setOpenPaths([file.relativePath]);
        if (draft && draft.content !== file.content) {
          if (draft.baseSha256 !== file.sha256) { setSaveState("error"); conflicts.onConflict({ manuscriptId: target.manuscriptId, relativePath: target.path, bufferedContent: draft.content }); }
          else setSaveState("dirty");
        }
      } catch (reason) { if (current) showError(reason instanceof Error ? reason.message : String(reason)); }
    })();
    return () => { current = false; };
  }, [gateway, target.token]);
  useEffect(() => { if (files.length) filesChanged.current(target.manuscriptId, files); }, [files, target.manuscriptId]);
  return <NoteFloatingWindow identity={target.token} title={writingNoteTitle(path ?? target.path)} label="写作笔记编辑面板"
    closeLabel="关闭写作笔记" resizeLabel="写作笔记" className="writing-note-floating-panel" panelRef={panel} canExpand={!!path}
    session={{ prepareClose: activity.saveCurrent, openTab: () => path ? onExpand({...target, path}) : Promise.resolve(false),
      dismiss: onClose, reportError: reason => showError(reason instanceof Error ? reason.message : String(reason)) }}>
    {({busy}) => <>
    {error && <div role="alert" className="writing-note-error">{error}</div>}
    {path ? <WritingNoteActivity.Provider value={activity.activity}>
      <WritingNoteToolbar manuscriptId={target.manuscriptId} path={path} content={content} saveState={saveState} onSave={() => void activity.saveCurrent()} />
      <div className="writing-note-floating-body"><Suspense fallback={<p>正在加载笔记编辑器…</p>}><WritingNoteEditor key={`${path}:${session}`} manuscriptId={target.manuscriptId} content={content} blockSourcePath={["writings", target.manuscriptId, ...path.split("/")]} onChange={value => { setContent(value); setSaveState("dirty"); }} readOnly={busy || !!conflicts.conflict} /></Suspense></div>
    </WritingNoteActivity.Provider> : !error && <p role="status">正在读取笔记…</p>}
    {conflicts.conflict && <WritingFileConflictDialog manuscriptId={target.manuscriptId} relativePath={conflicts.conflict.relativePath} bufferedContent={conflicts.conflict.bufferedContent} diskContent={conflicts.conflict.diskFile.content} onKeepEditing={conflicts.keepEditing}
      onReload={() => { conflicts.reload(); setSession(value => value + 1); }} onSaveAs={async value => { const saved = await conflicts.saveAs(value); if (saved) setSession(current => current + 1); return saved; }} />}
    </>}
  </NoteFloatingWindow>;
}
