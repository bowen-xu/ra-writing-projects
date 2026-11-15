/** @vitest-environment happy-dom */
import {act, useCallback, useState} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {emptyLiteratureDraft} from "@research-assistant/core/literature";
import {parseManuscriptPath, type CitationBinding, type Manuscript, type ManuscriptFile} from "@research-assistant/writing";
import {useWritingManuscriptLoader} from "./useWritingManuscriptLoader";
import {useWritingSourceIndex} from "./useWritingSourceIndex";
import type {LiteratureGateway} from "@research-assistant/data/literature";

type Options = Parameters<typeof useWritingManuscriptLoader>[0];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const value = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {value, resolve, reject};
}
function harness() {
  const root = createRoot(document.createElement("div"));
  const manuscripts = ["a", "b"].map(id => ({id, title: id, rootPath: parseManuscriptPath("main.tex"), status: "active", createdAt: "now", updatedAt: "now"} satisfies Manuscript));
  const files = (id: string): readonly ManuscriptFile[] => [{manuscriptId: id, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: id, sizeBytes: 10, modifiedAt: "now"}];
  const gateway = {
    listManuscripts: vi.fn(async () => manuscripts), listFiles: vi.fn(async (id: string) => files(id)),
    listDirectories: vi.fn(async () => []), listCitationBindings: vi.fn(async (_id: string): Promise<readonly CitationBinding[]> => []),
    getBibliographyStatus: vi.fn(async () => ({}) as never), getSession: vi.fn(async () => undefined), listRecoveryDrafts: vi.fn(async () => []),
    syncBibliography: vi.fn(async (_id: string, _entries: unknown[]) => ({}) as never), listBibliographyEntries: vi.fn(async () => []),
    supportsCompilation: false,
  };
  const dependencies = {gateway: gateway as unknown as Options["gateway"], literatureGateway: {get: vi.fn()} as Pick<LiteratureGateway,"get">,
    checkpoints: {hasCheckpoint: () => false} as unknown as Options["checkpoints"], layout: {restore: vi.fn()},
    setDirectories: vi.fn(), setOpenPaths: vi.fn(), setSaveState: vi.fn(), setError: vi.fn(), setBibliographyStatus: vi.fn(), setCursorOffsets: vi.fn(),
    setAutoCompile: vi.fn(), setCompilePreferences: vi.fn(), setPendingRecovery: vi.fn()};
  let select!: (id: string) => void;
  let ready = false;
  const open = vi.fn(async (_path: string, id?: string) => ({content: id!, sha256: id!}));
  function Host() {
    const [items, setManuscripts] = useState<readonly Manuscript[]>([]), [id, setId] = useState<string | undefined>("a");
    const [loadedManuscriptId, setLoadedManuscriptId] = useState<string>(), [isLoading, setIsLoading] = useState(false);
    const [metadata, setFiles] = useState<readonly ManuscriptFile[]>([]), [citationBindings, setCitationBindings] = useState<readonly CitationBinding[]>([]);
    const [activePath, setActivePath] = useState<string>(), [content, setContent] = useState(""), [hash, setContentHash] = useState<string>();
    select = setId; ready = id !== undefined && loadedManuscriptId === id;
    // Keep the production order: derived effects precede the loader's effects.
    useWritingSourceIndex({enabled: ready && !isLoading, metadataReady: ready, activeManuscriptId: id, activePath, content, savedContentHash: hash,
      files: metadata, citationBindings, gateway: dependencies.gateway, literatureGateway: dependencies.literatureGateway, setFiles, setError: dependencies.setError});
    const openFile = useCallback<Options["openFile"]>(async (path, project, isCurrent) => {
      const file = await open(path, project);
      if (isCurrent?.() !== false) {setActivePath(path); setContent(file.content); setContentHash(file.sha256);}
      return {...file, relativePath: parseManuscriptPath(path)};
    }, []);
    useWritingManuscriptLoader({...dependencies, activeManuscript: items.find(item => item.id === id),
      setLoadedManuscriptId, setManuscripts, setActiveManuscriptId: setId, setCitationBindings,
      setFiles, setActivePath, setContent, setContentHash, setIsLoading, openFile});
    return null;
  }
  return {gateway, dependencies, open, files, ready: () => ready,
    render: () => act(async () => root.render(<Host/>)), select: (id: string) => act(async () => select(id)),
    dispose: () => act(async () => root.unmount())};
}

it("never projects a new project with the previous project's files or saved hash", async () => {
  const h = harness();
  try {
    await h.render(); expect(h.ready()).toBe(true); expect(h.gateway.syncBibliography).toHaveBeenCalledExactlyOnceWith("a", []);
    const metadata = deferred<readonly ManuscriptFile[]>(), opened = deferred<{content: string; sha256: string}>();
    h.gateway.listFiles.mockImplementationOnce(() => metadata.value); h.open.mockImplementationOnce(() => opened.value);
    await h.select("b"); expect(h.ready()).toBe(false); expect(h.gateway.syncBibliography).toHaveBeenCalledTimes(1);
    await act(async () => metadata.resolve(h.files("b")));
    expect(h.ready()).toBe(false); expect(h.gateway.syncBibliography).toHaveBeenCalledTimes(1);
    await act(async () => opened.resolve({content: "b", sha256: "b"}));
    expect(h.ready()).toBe(true); expect(h.gateway.syncBibliography.mock.calls).toEqual([["a", []], ["b", []]]);
    await h.select("a"); expect(h.ready()).toBe(true);
    expect(h.gateway.syncBibliography).toHaveBeenCalledTimes(2);
    expect(h.gateway.listFiles.mock.calls.map(([id]) => id)).toEqual(["a", "a", "b", "b", "a"]);
    expect(h.dependencies.setError).not.toHaveBeenCalled();
  } finally {await h.dispose();}
});

it("does not activate projections after a failed load or a late response for an abandoned project", async () => {
  const h = harness();
  try {
    await h.render(); const late = deferred<readonly ManuscriptFile[]>();
    h.gateway.listFiles.mockImplementationOnce(() => late.value);
    await h.select("b"); await h.select("a");
    await act(async () => late.resolve(h.files("b")));
    expect(h.ready()).toBe(true); expect(h.gateway.syncBibliography.mock.calls).toEqual([["a", []]]);
    h.gateway.listFiles.mockRejectedValueOnce(new Error("metadata unavailable"));
    await h.select("b"); expect(h.ready()).toBe(false);
    expect(h.gateway.syncBibliography.mock.calls).toEqual([["a", []]]);
    expect(h.dependencies.setError).toHaveBeenCalledWith("metadata unavailable");
  } finally {await h.dispose();}
});

it.each(["resolve", "reject"] as const)("cancels an old binding refresh before it can sync into either project (%s)", async outcome => {
  const h = harness(), literature = deferred<Awaited<ReturnType<LiteratureGateway["get"]>>>();
  h.gateway.supportsCompilation = true;
  h.gateway.listCitationBindings.mockImplementation(async id => id === "a" ? [{literatureItemId: "synthetic", citationKey: "key"}] as CitationBinding[] : []);
  vi.mocked(h.dependencies.literatureGateway.get).mockImplementation(() => literature.value);
  try {
    await h.render(); expect(h.dependencies.literatureGateway.get).toHaveBeenCalledOnce();
    await h.select("b"); expect(h.dependencies.literatureGateway.get).toHaveBeenCalledOnce();
    await act(async () => {
      if (outcome === "reject") literature.reject(new Error("old lookup failed"));
      else literature.resolve({...emptyLiteratureDraft(), id: "synthetic", title: "Synthetic citation", readingStatus: "unread", attachments: [], projectIds: [], metadataSources: [], createdAt: "now", updatedAt: "now"});
    });
    expect(h.gateway.syncBibliography.mock.calls).toEqual([["b", []]]);
    expect(h.dependencies.setError).not.toHaveBeenCalled();
  } finally {await h.dispose();}
});
