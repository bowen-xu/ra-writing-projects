import {expect,it,vi} from "vitest";
import {emptyLiteratureDraft,type LiteratureItem} from "@research-assistant/core/literature";
import {parseManuscriptPath,type CitationBinding} from "@research-assistant/writing";
import {WritingBibliographyReads} from "./WritingBibliographyReads";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const value = new Promise<T>(done => {resolve = done;});return {value,resolve};
}
function fixture() {
  const item: LiteratureItem = {...emptyLiteratureDraft(),id:"library",title:"Current library metadata",bibtexKey:"different-library-key",
    attachments:[],projectIds:[],metadataSources:[],readingStatus:"unread",createdAt:"now",updatedAt:"now"};
  const bindings: readonly CitationBinding[] = [{manuscriptId:"p",literatureItemId:item.id,citationKey:"pinned",bibtexEntry:"old metadata",state:"active",pinnedAt:"then",updatedAt:"then"}];
  const library = {get:vi.fn(async () => item)};
  const status = {status:"ready" as const,relativePath:parseManuscriptPath("references.bib"),contentHash:"projection",warnings:[]};
  const gateway = {supportsCompilation:true,syncBibliography:vi.fn(async (_id: string,_inputs: readonly unknown[]) => status),listFiles:vi.fn(async () => [])};
  const owner = new WritingBibliographyReads(gateway,library);
  const read = (hash = "one",project = "p",batch = bindings) => {
    const pending = owner.ensure(project,[["main.tex",hash]],"main.tex",hash,batch);
    if (!pending) throw Error("Expected an undelivered projection");
    return {pending,release:pending.observe()};
  };
  return {item,bindings,library,gateway,status,owner,read};
}

it("combines latest library metadata and source projection once, retaining pinned keys",async () => {
  const f = fixture(), first = f.read();
  expect((await first.pending.value).kind).toBe("ready");first.pending.accept();first.release();
  expect(f.library.get).toHaveBeenCalledExactlyOnceWith("library");
  expect(f.gateway.syncBibliography).toHaveBeenCalledExactlyOnceWith("p",[expect.objectContaining({literatureItemId:"library",requestedKey:"pinned",bibtexEntry:expect.stringContaining("Current library metadata")})]);
  expect(f.gateway.syncBibliography.mock.calls[0]?.[1]).toEqual([expect.objectContaining({bibtexEntry:expect.stringContaining("{pinned,")})]);
  for (let trip = 0; trip < 5; trip++) expect(f.owner.ensure("p",[["main.tex","one"]],"main.tex","one",f.bindings)).toBeUndefined();
  // Metadata reload is a distinct event even if the binding bytes are equal.
  f.owner.invalidate("p");f.library.get.mockResolvedValueOnce({...f.item,title:"Reloaded title"});
  const reloaded = f.read();await reloaded.pending.value;reloaded.release();
  expect(f.gateway.syncBibliography.mock.calls[1]?.[1]).toEqual([expect.objectContaining({bibtexEntry:expect.stringContaining("Reloaded title")})]);
});

it("coalesces consumers that rejoin during a pending metadata read",async () => {
  const f = fixture(), held = deferred<LiteratureItem>();f.library.get.mockReturnValueOnce(held.value);
  const first = f.read();await Promise.resolve();expect(f.library.get).toHaveBeenCalledOnce();
  first.release();const second = f.read();expect(second.pending).toBe(first.pending);
  held.resolve(f.item);expect((await second.pending.value).kind).toBe("ready");second.release();
  expect(f.gateway.syncBibliography).toHaveBeenCalledOnce();
});

it("does not reload library metadata on a source-only save, but refreshes a new binding read",async () => {
  const f = fixture(), first = f.read();await first.pending.value;first.pending.accept();first.release();
  const saved = f.read("two");await saved.pending.value;saved.pending.accept();saved.release();
  expect(f.library.get).toHaveBeenCalledOnce();
  expect(f.gateway.syncBibliography.mock.calls[1]).toEqual(["p",[]]);
  const reread = f.read("two","p",[...f.bindings]);await reread.pending.value;reread.release();
  expect(f.library.get).toHaveBeenCalledTimes(2);
});

it("does not start an unobserved preparation and permits a later real consumer",async () => {
  const f = fixture(), first = f.read();first.release();
  expect(await first.pending.value).toEqual({kind:"cancelled"});
  expect(f.library.get).not.toHaveBeenCalled();expect(f.gateway.syncBibliography).not.toHaveBeenCalled();
  const retry = f.read();expect((await retry.pending.value).kind).toBe("ready");retry.release();
});

it.each(["leave","invalidate","new source","new bindings"])("prevents stale metadata from dispatching a write after %s",async transition => {
  const f = fixture(), held = deferred<LiteratureItem>();f.library.get.mockReturnValueOnce(held.value);
  const first = f.read();await Promise.resolve();
  let current: ReturnType<typeof f.read> | undefined;
  if (transition === "leave") first.release();
  else if (transition === "invalidate") f.owner.invalidate("p");
  else current = f.read(transition === "new source" ? "two" : "one","p",transition === "new bindings" ? [...f.bindings] : f.bindings);
  if (current) {expect((await current.pending.value).kind).toBe("ready");current.release();}
  held.resolve({...f.item,title:"Stale"});expect(await first.pending.value).toEqual({kind:"cancelled"});first.release();
  expect(f.gateway.syncBibliography).toHaveBeenCalledTimes(current ? 1 : 0);
});

it("finishes a dispatched operation while hidden and reuses its undelivered receipt",async () => {
  const f = fixture(), held = deferred<typeof f.status>();f.gateway.syncBibliography.mockReturnValueOnce(held.value);
  const first = f.read();await vi.waitFor(() => expect(f.gateway.syncBibliography).toHaveBeenCalledOnce());first.release();
  held.resolve(f.status);expect((await first.pending.value).kind).toBe("ready");
  const returned = f.read();expect(returned.pending).toBe(first.pending);await returned.pending.value;returned.pending.accept();returned.release();
  expect(f.gateway.syncBibliography).toHaveBeenCalledOnce();expect(f.gateway.listFiles).toHaveBeenCalledOnce();
});

it.each(["metadata","projection"])("preserves the original %s error and retries with fresh preparation",async phase => {
  const f = fixture(), reason = Object.assign(new Error("Synthetic failure"),{code:"operation_failed",operationId:"synthetic"});
  if (phase === "metadata") f.library.get.mockRejectedValueOnce(reason);else f.gateway.syncBibliography.mockRejectedValueOnce(reason);
  const first = f.read();await expect(first.pending.value).rejects.toBe(reason);first.release();
  const retry = f.read();expect((await retry.pending.value).kind).toBe("ready");retry.release();
  expect(f.library.get).toHaveBeenCalledTimes(2);
});
