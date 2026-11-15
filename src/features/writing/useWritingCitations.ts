import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { exportLiterature } from "@research-assistant/core/citation";
import { isWritingNotePath, createStableCitationKey, type BibliographyStatus, type CitationBinding, type CitationCandidate, type CitationScope, type ManuscriptFile } from "@research-assistant/writing";
import type {LiteratureGateway} from "@research-assistant/data/literature";
import type { WritingGateway } from "./gateway";
import { errorMessage } from "./workspaceState";

type Setter<T> = Dispatch<SetStateAction<T>>;
interface Options {
  readonly reconcileCitationKeys?: (id: string, pendingIds: readonly string[]) => Promise<unknown>;
  readonly activeManuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly gateway: WritingGateway;
  readonly literatureGateway: Pick<LiteratureGateway, "get"> | undefined;
  readonly citationBindings: readonly CitationBinding[];
  readonly compiler: { readonly markSourceChanged: () => void };
  readonly setCitationBindings: Setter<readonly CitationBinding[]>;
  readonly setBibliographyStatus: Setter<BibliographyStatus | undefined>;
  readonly setFiles: Setter<readonly ManuscriptFile[]>;
  readonly setInsertionRequest: Setter<{ readonly text: string; readonly token: number } | undefined>;
  readonly setError: Setter<string | undefined>;
}

export function useWritingCitations({ activeManuscriptId, activePath, gateway, literatureGateway, citationBindings, compiler,
  setCitationBindings, setBibliographyStatus, setFiles, setInsertionRequest, setError, reconcileCitationKeys }: Options) {
  const target = useRef({activeManuscriptId, activePath, gateway});
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  target.current = {activeManuscriptId, activePath, gateway};
  const ownsTarget = () => mounted.current && target.current.gateway === gateway
    && target.current.activeManuscriptId === activeManuscriptId && target.current.activePath === activePath;
  const searchCitations = useCallback((query: string, scope: CitationScope) => {
    if (activeManuscriptId === undefined) return Promise.resolve([]);
    return gateway.searchCitations(activeManuscriptId, query, scope);
  }, [activeManuscriptId, gateway]);

  // Both the picker and inline completion publish through the same managed
  // binding boundary. Return the authoritative key after collision resolution.
  async function bindCitations(candidates: readonly CitationCandidate[]): Promise<readonly string[]> {
    if (activeManuscriptId === undefined || activePath === undefined || isWritingNotePath(activePath) || /\.bib$/iu.test(activePath)) {
      throw new Error("请先打开需要插入引用的稿件源码。");
    }
    if (!candidates.length) return [];
    if (!literatureGateway) throw new Error("literature_citations_unavailable：未装配文献插件；已有引用与稿件内容已保留。");
    const occupied = new Set(citationBindings.map((binding) => binding.citationKey));
    const bound: CitationBinding[] = [];
    for (const candidate of candidates) {
      const item = await literatureGateway.get(candidate.literatureItemId);
      if (!ownsTarget()) throw new Error("引用目标已切换，请在当前文件重新选择文献。");
      const firstAuthor = item.creators[0]?.familyName || item.creators[0]?.literalName;
      const requestedKey = candidate.citationKey ?? createStableCitationKey({
        importedKey: item.bibtexKey,
        ...(firstAuthor === undefined ? {} : { firstAuthor }),
        ...(item.issuedYear === undefined ? {} : { issuedYear: item.issuedYear }),
        title: item.title,
      }, occupied);
      const binding = await gateway.bindCitation(activeManuscriptId, {
        literatureItemId: item.id,
        requestedKey,
        bibtexEntry: exportLiterature([{ ...item, bibtexKey: requestedKey }], "bibtex"),
      });
      occupied.add(binding.citationKey);
      bound.push(binding);
    }
    await reconcileCitationKeys?.(activeManuscriptId,candidates.map(row => row.literatureItemId));
    const [bindings, status, files] = await Promise.all([
      gateway.listCitationBindings(activeManuscriptId), gateway.getBibliographyStatus(activeManuscriptId), gateway.listFiles(activeManuscriptId),
    ]);
    if (!ownsTarget()) throw new Error("文献已加入原稿件的参考文献，引用目标已切换，请重新选择插入位置。");
    setCitationBindings(bindings);
    setBibliographyStatus(status);
    setFiles(files);
    compiler.markSourceChanged();
    return bound.map(binding => bindings.find(row => row.literatureItemId === binding.literatureItemId)?.citationKey ?? binding.citationKey);
  }

  async function insertCitations(candidates: readonly CitationCandidate[]): Promise<void> {
    const keys = await bindCitations(candidates);
    if (keys.length) setInsertionRequest({ text: `\\cite{${keys.join(",")}}`, token: Date.now() });
  }

  async function bindCitation(candidate: CitationCandidate): Promise<string> {
    const [key] = await bindCitations([candidate]);
    if (!key) throw new Error("未能生成引用键，请重新选择文献。");
    return key;
  }

  async function resolveBibliographyConflict(preserve: boolean): Promise<void> {
    if (activeManuscriptId === undefined) return;
    setError(undefined);
    try {
      const status = preserve
        ? await gateway.preserveBibliographyEdits(activeManuscriptId)
        : await gateway.regenerateBibliography(activeManuscriptId);
      setBibliographyStatus(status);
      setFiles(await gateway.listFiles(activeManuscriptId));
      compiler.markSourceChanged();
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    }
  }

  return { searchCitations, bindCitation, insertCitations, resolveBibliographyConflict };
}
