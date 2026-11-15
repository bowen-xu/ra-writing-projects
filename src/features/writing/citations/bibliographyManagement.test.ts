import { expect,it,vi } from "vitest";
import type { LiteratureItem } from "@research-assistant/core/literature";
import type { ProjectBibliographyEntry } from "@research-assistant/writing";
import type { LiteratureGateway } from "@research-assistant/data/literature";
import type { WritingGateway } from "../gateway";
import { matchBibliographyItem,promoteBibliographyEntries } from "./bibliographyManagement";
const item: LiteratureItem={id:"known",itemType:"journalArticle",title:"Synthetic title",abstractText:"",issuedYear:2026,containerTitle:"Journal",volume:"1",issue:"",pages:"",doi:"10.1234/test",url:"",language:"en",bibtexKey:"known2026",creators:[{familyName:"Smith",givenName:"",literalName:"",role:"author"}],tags:[],readingStatus:"unread",attachments:[],projectIds:[],metadataSources:[],createdAt:"now",updatedAt:"now"};
function row(id: string,draft=item):ProjectBibliographyEntry{return {id,manuscriptId:"m",citationKey:id,originalKey:id,originalBibtex:"original",bibtexEntry:"canonical",imported:draft,current:draft,libraryItem:null,paths:["local.bib"]};}
it("matches unique DOI then title/year/author, and preserves ambiguity and DOI disagreement",()=>{
 expect(matchBibliographyItem({...item,title:"Import title",doi:"https://doi.org/10.1234/TEST"},[item])?.id).toBe("known");
 expect(matchBibliographyItem({...item,doi:""},[item])?.id).toBe("known");
 expect(matchBibliographyItem({...item,doi:"10.1234/other"},[item])).toBeUndefined();
 expect(matchBibliographyItem(item,[item,{...item,id:"duplicate"}])).toBeUndefined();
});
it("explicit batch promotion rechecks each row and reuses an existing library item",async()=>{
 const records:LiteratureItem[]=[item];const save=vi.fn(async(draft)=>{const saved={...item,...draft};records.push(saved);return saved;});
 const literature={list:vi.fn(async()=>records),save} as unknown as LiteratureGateway;
 const writing={linkBibliographyEntry:vi.fn(async()=>undefined)} as unknown as WritingGateway;
 await promoteBibliographyEntries([row("existing"),row("one",{...item,doi:"10.1234/new"}),row("two",{...item,doi:"10.1234/new"})],literature,writing);
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0]?.[0].id).toBe("one");expect(writing.linkBibliographyEntry).toHaveBeenNthCalledWith(1,"m","existing","known");expect(writing.linkBibliographyEntry).toHaveBeenNthCalledWith(3,"m","two","one");
});
it("reuses the stable new-library identity after a lost link reply",async()=>{
 const records:LiteratureItem[]=[];const save=vi.fn(async(draft)=>{const saved={...item,...draft};records.push(saved);return saved;});
 const literature={list:async()=>records,save} as unknown as LiteratureGateway;
 const writing={linkBibliographyEntry:vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue(undefined)} as unknown as WritingGateway;
 const entry=row("stable",{...item,doi:"",creators:[]});
 await expect(promoteBibliographyEntries([entry],literature,writing)).rejects.toThrow("reply lost");await promoteBibliographyEntries([entry],literature,writing);expect(save).toHaveBeenCalledTimes(1);
});
it("never creates another library item when existing matches are ambiguous",async()=>{
 const literature={list:async()=>[item,{...item,id:"duplicate"}],save:vi.fn()} as unknown as LiteratureGateway;
 const writing={linkBibliographyEntry:vi.fn()} as unknown as WritingGateway;
 await expect(promoteBibliographyEntries([row("project")],literature,writing)).rejects.toThrow("多条匹配记录");expect(literature.save).not.toHaveBeenCalled();expect(writing.linkBibliographyEntry).not.toHaveBeenCalled();
});
it("does not promote or retarget known relations when their live metadata is unavailable, including old wire bindings",async()=>{
 const literature={list:vi.fn(),save:vi.fn()} as unknown as LiteratureGateway;
 const writing={linkBibliographyEntry:vi.fn()} as unknown as WritingGateway;
 expect(await promoteBibliographyEntries([{...row("linked"),libraryItemId:"original-source"},row("binding:legacy-source")],literature,writing)).toBe(0);
 expect(literature.list).not.toHaveBeenCalled();expect(literature.save).not.toHaveBeenCalled();expect(writing.linkBibliographyEntry).not.toHaveBeenCalled();
});
