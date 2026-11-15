// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {parseManuscriptPath,type BibliographyStatus,type ManuscriptFile} from "@research-assistant/writing";
import type {WritingGateway} from "./gateway";
import {useWritingSourceIndex} from "./useWritingSourceIndex";

function harness() {
  const root=createRoot(document.createElement("div"));
  const sync=vi.fn().mockResolvedValue({status:"ready"}),read=vi.fn().mockResolvedValue({content:"new projection",sha256:"new"});
  const setFiles=vi.fn(),setContent=vi.fn(),setContentHash=vi.fn(),setError=vi.fn();
  const literatureGateway = {get:vi.fn()};
  const gateway={syncBibliography:sync,listFiles:vi.fn().mockResolvedValue([]),listBibliographyEntries:vi.fn().mockResolvedValue([]),readFile:read} as unknown as WritingGateway;
  function Host({hash,content="source",path="main.tex",files=[]}:{hash:string;content?:string;path?:string;files?:readonly ManuscriptFile[]}) {
    useWritingSourceIndex({activeManuscriptId:"m",activePath:path,content,savedContentHash:hash,files,citationBindings:[],gateway,literatureGateway,
      setFiles,setContent,setContentHash,setError});return null;
  }
  return {sync,read,setFiles,setContent,setContentHash,setError,gateway,
    render:(props:Parameters<typeof Host>[0])=>act(async()=>root.render(<Host {...props}/>)),
    dispose:()=>act(async()=>root.unmount())};
}

it("reconciles only committed hashes, retaining recovery metadata and not pruning partial editor input",async()=>{
  const h=harness();try {
    const files: readonly ManuscriptFile[] = [{manuscriptId: "m", relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: "saved-one", sizeBytes: 10, modifiedAt: "now"}];
    await h.render({hash:"saved-one", files});expect(h.sync).toHaveBeenCalledOnce();
    expect(h.gateway.listBibliographyEntries).toHaveBeenCalledWith("m",true);
    await h.render({hash:"saved-one",files,content:"\\cite{partial"});expect(h.sync).toHaveBeenCalledOnce();
    await h.render({hash:"saved-two",files,content:"\\cite{}"});expect(h.sync).toHaveBeenCalledTimes(2);
    h.sync.mockRejectedValueOnce(new Error("projection conflict"));
    await h.render({hash:"saved-three",files});expect(h.setError).toHaveBeenCalledWith("projection conflict");
    expect(h.setContent).not.toHaveBeenCalled();expect(h.setContentHash).not.toHaveBeenCalled();
  }finally{await h.dispose();}
});

it("refreshes a changed visible read-only projection and rejects reads that finish after file switching",async()=>{
  const h=harness();try {
    const file={manuscriptId:"m",relativePath:parseManuscriptPath("references.bib"),kind:"bib",sha256:"new",sizeBytes:20,modifiedAt:"now"} satisfies ManuscriptFile;
    await h.render({hash:"old",path:"references.bib",files:[file]});
    expect(h.setContent).toHaveBeenCalledWith("new projection");expect(h.setContentHash).toHaveBeenCalledWith("new");
    h.setContent.mockClear();h.setContentHash.mockClear();
    let finish!:(value:unknown)=>void;h.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await h.render({hash:"new",path:"references.bib",files:[{...file,sha256:"newer"}]});
    await h.render({hash:"source",path:"main.tex"});
    await act(async()=>finish({content:"stale projection",sha256:"newer"}));
    expect(h.setContent).not.toHaveBeenCalled();expect(h.setContentHash).not.toHaveBeenCalled();
  }finally{await h.dispose();}
});

it("publishes through the latest status callback without restarting citation queries or starving outline analysis",async () => {
  vi.useFakeTimers();
  const container = document.createElement("div"), root = createRoot(container), first = vi.fn(), latest = vi.fn(), changed = vi.fn();
  const files: readonly ManuscriptFile[] = [{manuscriptId:"m",relativePath:parseManuscriptPath("main.tex"),kind:"tex",sha256:"saved",sizeBytes:30,modifiedAt:"now"}];
  const status = {status:"ready" as const,relativePath:parseManuscriptPath("references.bib"),contentHash:"new",warnings:[]};
  let finish!: (value: typeof status) => void;
  const gateway = {supportsCompilation:false,syncBibliography:vi.fn(() => new Promise<typeof status>(resolve => {finish = resolve;})),
    listFiles:vi.fn(async () => files),listBibliographyEntries:vi.fn(async () => [])} as unknown as WritingGateway;
  const literatureGateway = {get:vi.fn()}, setError = vi.fn();
  function Host({publish}: {publish: (value: BibliographyStatus) => void}) {
    const result = useWritingSourceIndex({activeManuscriptId:"m",activePath:"main.tex",files,citationBindings:[],gateway,literatureGateway,
      content:"\\section{Current outline}",savedContentHash:"saved",setError,setBibliographyStatus: value => publish(value),
      bibliographyStatus:{...status,contentHash:"old"},onBibliographyChanged: () => changed()});
    return <span>{result.outline.map(entry => entry.title).join(",")}</span>;
  }
  try {
    await act(async () => root.render(<Host publish={first}/>));
    await act(async () => root.render(<Host publish={latest}/>));
    await act(async () => finish(status));await act(async () => vi.advanceTimersByTime(250));
    expect(first).not.toHaveBeenCalled();expect(latest).toHaveBeenCalledExactlyOnceWith(status);
    expect(gateway.listBibliographyEntries).toHaveBeenCalledOnce();expect(gateway.syncBibliography).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Current outline");expect(setError).not.toHaveBeenCalled();
  } finally {await act(async () => root.unmount());vi.useRealTimers();}
});
