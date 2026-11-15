import { inspectCitationKeys, type BibliographyStatus, type CitationBinding, type CitationUsage, type LatexOutlineEntry, type ManuscriptFile } from "@research-assistant/writing";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type {LiteratureGateway} from "@research-assistant/data/literature";
import type { WritingGateway } from "./gateway";
import { errorMessage } from "./workspaceState";
import { citationLabels, type WritingCitationLabel } from "./citations/citationLabels";
import { WritingSourceReads } from "./WritingSourceReads";
import { WritingBibliographyReads } from "./WritingBibliographyReads";

interface SourceIndexOptions {
  readonly enabled?: boolean;
  readonly metadataReady?: boolean;
  readonly activeManuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly content: string;
  readonly savedContentHash?: string | undefined;
  readonly files: readonly ManuscriptFile[];
  readonly citationBindings: readonly CitationBinding[];
  readonly gateway: WritingGateway;
  readonly literatureGateway: Pick<LiteratureGateway,"get"> | undefined;
  readonly bibliographyStatus?: BibliographyStatus | undefined;
  readonly onBibliographyChanged?: (() => void) | undefined;
  readonly setBibliographyStatus?: ((status: BibliographyStatus) => void) | undefined;
  readonly setFiles?: ((files: readonly ManuscriptFile[]) => void) | undefined;
  readonly setContent?: ((content: string) => void) | undefined;
  readonly setContentHash?: ((hash: string) => void) | undefined;
  readonly setError: (message: string) => void;
}
const noCitationReferences: readonly WritingCitationLabel[] = [];

export function useWritingSourceIndex({ enabled: requestedEnabled = true, metadataReady = true, activeManuscriptId, activePath, content, savedContentHash, files, citationBindings, gateway, literatureGateway, bibliographyStatus, onBibliographyChanged, setError, setBibliographyStatus, setFiles, setContent, setContentHash }: SourceIndexOptions) {
  const enabled = requestedEnabled && metadataReady;
  const sourceReads = useMemo(() => new WritingSourceReads(gateway), [gateway]);
  const bibliographyReads = useMemo(() => new WritingBibliographyReads(gateway,literatureGateway), [gateway,literatureGateway]);
  const [managedKeys,setManagedKeys] = useState<readonly string[]>([]);
  const [citationReferences,setCitationReferences] = useState<{readonly manuscriptId: string; readonly labels: readonly WritingCitationLabel[]}>();
  const [bibliographyReady,setBibliographyReady] = useState<string>();
  const bibliographyRevision=JSON.stringify(files.filter(file=>file.kind==="bib").map(file=>[file.relativePath,file.sha256]));
  const sourceRevision=JSON.stringify(files.filter(file=>file.kind==="tex").map(file=>[file.relativePath,file.sha256]));
  const refreshLibraryMetadata = !!literatureGateway && metadataReady && gateway.supportsCompilation && citationBindings.length > 0;
  useEffect(() => {
    if (refreshLibraryMetadata && activeManuscriptId) bibliographyReads.invalidate(activeManuscriptId);
  },[refreshLibraryMetadata,activeManuscriptId,bibliographyReads]);
  const publishProjection = useEffectEvent((project: string, revision: string, status: BibliographyStatus, updated?: readonly ManuscriptFile[]) => {
    if (!enabled || activeManuscriptId !== project || sourceRevision !== revision) return false;
    if (bibliographyStatus?.contentHash !== undefined && bibliographyStatus.contentHash !== status.contentHash) onBibliographyChanged?.();
    setBibliographyStatus?.(status);if (updated) setFiles?.(updated);
    return true;
  });
  useEffect(() => {
    if (!enabled || !activeManuscriptId || !activePath || !/\.bib$/iu.test(activePath)) return;
    const projected = files.find(file => file.relativePath === activePath);
    if (!projected || projected.sha256 === savedContentHash) return;
    let active = true;
    // A derived read-only file may already be visible when the source save's
    // projection finishes. Refresh it without touching editable file sessions.
    void gateway.readFile(activeManuscriptId, activePath).then(file => {
      if (active) {setContent?.(file.content);setContentHash?.(file.sha256);}
    }).catch(reason => {if (active) setError(errorMessage(reason));});
    return () => {active = false;};
  }, [enabled, activeManuscriptId, activePath, savedContentHash, bibliographyRevision, files, gateway, setContent, setContentHash, setError]);
  useEffect(() => {
    if (!enabled || !activeManuscriptId) return;
    const pending = bibliographyReads.ensure(activeManuscriptId, files.filter(file => file.kind === "tex").map(file => [file.relativePath, file.sha256]), activePath, savedContentHash,citationBindings);
    if (!pending) return;
    const release = pending.observe();
    let active = true;
    // Read committed manuscript sources in the adapter. Never prune against a
    // partial editor buffer or change the source-save receipt on projection failure.
    void pending.value.then(result => {
      if (!active || result.kind === "cancelled") return;
      if (publishProjection(activeManuscriptId,sourceRevision,result.status,result.files)) pending.accept();
    }).catch(async reason => {
      if (!active) return;
      setError(errorMessage(reason));
      try {const status=await gateway.getBibliographyStatus(activeManuscriptId);if(active)publishProjection(activeManuscriptId,sourceRevision,status);} catch {/* Preserve the original projection error. */}
    });
    return () => {active = false;release();};
  }, [enabled, activeManuscriptId, activePath, savedContentHash, sourceRevision, citationBindings, bibliographyReads, gateway, setError]);
  useEffect(()=>{
    if(!enabled || !activeManuscriptId)return;
    let active=true;setBibliographyReady(undefined);
    void gateway.listBibliographyEntries(activeManuscriptId, true).then(entries=>{
      if(active){setManagedKeys(entries.map(entry=>entry.citationKey));setCitationReferences({manuscriptId:activeManuscriptId,labels:citationLabels(entries)});setBibliographyReady(activeManuscriptId);}
    }).catch(async reason=>{if(active){setError(errorMessage(reason));try{const status=await gateway.getBibliographyStatus(activeManuscriptId);if(active)publishProjection(activeManuscriptId,sourceRevision,status);}catch{/* Original error remains in the shared notification. */}}});
    return ()=>{active=false;};
  },[enabled,activeManuscriptId,bibliographyRevision,gateway,setError]);
  const [citationUsage, setCitationUsage] = useState<CitationUsage>({ usedKeys: [], unusedKeys: [], missingKeys: [] });
  const [latexLabels, setLatexLabels] = useState<readonly string[]>([]);
  const [outline, setOutline] = useState<readonly LatexOutlineEntry[]>([]);
  useEffect(() => {
    if (!enabled) return;
    if (activeManuscriptId === undefined) { setOutline([]); setLatexLabels([]); setCitationUsage({usedKeys:[],unusedKeys:[],missingKeys:[]}); return; }
    let active = true;
    const timeout = window.setTimeout(() => {
      sourceReads.prune(activeManuscriptId, files);
      void Promise.all(files.filter((file) => file.kind === "tex").map(async (file) => ({
        path: file.relativePath,
        parsed: file.relativePath === activePath ? sourceReads.live(activeManuscriptId, file.relativePath, content) : await sourceReads.committed(activeManuscriptId, file),
      }))).then((sources) => {
        if (!active) return;
        setCitationUsage(bibliographyReady===activeManuscriptId ? inspectCitationKeys(sources.flatMap(item => item.parsed.citationKeys), citationBindings, managedKeys) : {usedKeys:[],unusedKeys:[],missingKeys:[]});
        setLatexLabels([...new Set(sources.flatMap(item => item.parsed.index.labels))].sort());
        setOutline(sources.find(item => item.path === activePath)?.parsed.index.outline ?? []);
      }).catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [enabled, activeManuscriptId, activePath, citationBindings, content, files, sourceReads, setError, bibliographyReady, managedKeys]);
  return { managedKeys, citationReferences: citationReferences?.manuscriptId === activeManuscriptId ? citationReferences?.labels ?? noCitationReferences : noCitationReferences, citationUsage, latexLabels, outline };
}
