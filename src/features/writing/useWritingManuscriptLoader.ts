import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { BibliographyStatus, CitationBinding, Manuscript, ManuscriptDirectory, ManuscriptFile, RecoveryDraft } from "@research-assistant/writing";
import type { WritingGateway } from "./gateway";
import type { WritingCheckpointPersistence } from "./persistence/WritingCheckpointPersistence";
import type { useWritingFileLoader } from "./useWritingFileLoader";
import type { useWritingLayout } from "./useWritingLayout";
import { readCompilePreferences } from "./compilePreferences";
import { errorMessage, readAutoCompile, readCursorOffsets, type SaveState } from "./workspaceState";
import type { WritingProjectTabs } from "./tabs/WritingProjectTabs";

type Setter<T> = Dispatch<SetStateAction<T>>;
interface Options {
  readonly onCatalogReady?: (ready:boolean)=>void;
  readonly tabs?: Pick<WritingProjectTabs, "get">;
  readonly activeManuscript: Manuscript | undefined;
  readonly setLoadedManuscriptId: Setter<string | undefined>;
  readonly gateway: WritingGateway;
  readonly checkpoints: WritingCheckpointPersistence;
  readonly openFile: ReturnType<typeof useWritingFileLoader>;
  readonly layout: Pick<ReturnType<typeof useWritingLayout>, "restore">;
  readonly setManuscripts: Setter<readonly Manuscript[]>;
  readonly setActiveManuscriptId: Setter<string | undefined>;
  readonly setFiles: Setter<readonly ManuscriptFile[]>;
  readonly setDirectories: Setter<readonly ManuscriptDirectory[]>;
  readonly setOpenPaths: Setter<readonly string[]>;
  readonly setActivePath: Setter<string | undefined>;
  readonly setContent: Setter<string>;
  readonly setContentHash: Setter<string | undefined>;
  readonly setSaveState: Setter<SaveState>;
  readonly setIsLoading: Setter<boolean>;
  readonly setError: Setter<string | undefined>;
  readonly setCitationBindings: Setter<readonly CitationBinding[]>;
  readonly setBibliographyStatus: Setter<BibliographyStatus | undefined>;
  readonly setCursorOffsets: Setter<Readonly<Record<string, number>>>;
  readonly setAutoCompile: Setter<boolean>;
  readonly setCompilePreferences: Setter<ReturnType<typeof readCompilePreferences>>;
  readonly setPendingRecovery: Setter<RecoveryDraft | undefined>;
}

/** Load project-owned metadata and restore the initial file. Derived source and
 * bibliography work starts only after this boundary reports readiness.
 */
export function useWritingManuscriptLoader(options: Options): void {
  const onCatalogReady=options.onCatalogReady;
  const { tabs, activeManuscript, setLoadedManuscriptId, gateway, checkpoints, openFile, layout,
    setManuscripts, setActiveManuscriptId, setFiles, setDirectories, setOpenPaths,
    setActivePath, setContent, setContentHash, setSaveState, setIsLoading, setError, setCitationBindings,
    setBibliographyStatus, setCursorOffsets, setAutoCompile, setCompilePreferences, setPendingRecovery } = options;
  useEffect(() => {
    let active = true;
    onCatalogReady?.(false);
    setIsLoading(true);
    void gateway.listManuscripts()
      .then((items) => {
        if (!active) return;
        setManuscripts(items);
        onCatalogReady?.(true);
        setActiveManuscriptId((current) => items.some((item) => item.id === current)
          ? current
          : undefined);
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)))
      .finally(() => active && setIsLoading(false));
    return () => { active = false; };
  }, [gateway,onCatalogReady]);

  useEffect(() => {
    setLoadedManuscriptId(undefined);
    if (activeManuscript === undefined) {
      setFiles([]);
      setDirectories([]);
      setOpenPaths([]);
      setActivePath(undefined);
      return;
    }
    let active = true;
    setActivePath(undefined);
    setContent("");
    setContentHash(undefined);
    setOpenPaths([]);
    setSaveState("saved");
    setIsLoading(true);
    void Promise.all([
      gateway.listFiles(activeManuscript.id),
      gateway.listDirectories(activeManuscript.id),
      gateway.listCitationBindings(activeManuscript.id),
      gateway.getBibliographyStatus(activeManuscript.id),
      gateway.getSession(activeManuscript.id),
      gateway.listRecoveryDrafts(activeManuscript.id),
    ])
      .then(async ([items, directoryItems, bindings, bibliography, session, recoveryDrafts]) => {
        if (!active) return;
        setFiles(items);
        setDirectories(directoryItems);
        setCitationBindings(bindings);
        setBibliographyStatus(bibliography);
        const cached = tabs?.get(activeManuscript.id);
        const layoutState = cached?.layoutState ?? session?.layoutState;
        setCursorOffsets(readCursorOffsets(cached?.cursorState ?? session?.cursorState));
        setAutoCompile(readAutoCompile(layoutState));
        setCompilePreferences(readCompilePreferences(layoutState?.compilePreferences));
        layout.restore(layoutState);
        const availablePaths = new Set<string>(items.map((item) => item.relativePath));
        const restoredPaths = (cached?.openPaths ?? session?.openPaths ?? []).filter((path) => availablePaths.has(path));
        const targetPath = cached ? (cached.activePath && availablePaths.has(cached.activePath) ? cached.activePath : restoredPaths.at(-1))
          : session?.activePath !== undefined && availablePaths.has(session.activePath)
          ? session.activePath
          : activeManuscript.rootPath;
        setOpenPaths(restoredPaths);
        const opened = targetPath === undefined ? undefined : await openFile(targetPath, activeManuscript.id, () => active,
          {files: items, openPaths: restoredPaths});
        const recovery = recoveryDrafts.find((draft) => draft.relativePath === targetPath);
        if (active && targetPath !== undefined && opened !== undefined && !checkpoints.hasCheckpoint({ manuscriptId: activeManuscript.id, relativePath: targetPath })
          && recovery?.baseSha256 === opened.sha256 && recovery.content !== opened.content) {
          setPendingRecovery(recovery);
        }
        if (active) setLoadedManuscriptId(activeManuscript.id);
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)))
      .finally(() => active && setIsLoading(false));
    return () => { active = false; };
  }, [activeManuscript?.id, gateway, layout.restore, openFile, checkpoints, tabs]);
}
