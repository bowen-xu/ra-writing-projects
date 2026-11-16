import { getStructuredResourceGateway } from "@research-assistant/workbench-preview/structured-resource-gateway";
import { decodeAgentArchiveRequest, decodeAgentCatalogPage, decodeAgentRenameResponse, decodeAgentRenameRequest, decodeAgentDeletionResponse, decodeAgentDeletionWriteOptions, decodeAgentSearchPage, type AgentConversationSummary } from "@research-assistant/core/agent";
import type { AgentCatalogGateway, AgentMetadataGateway, AgentArchiveGateway, AgentDeletionGateway, AgentSearchGateway, AgentConversationExportGateway } from "@research-assistant/data/agent";
import { agentContextGroupParts, agentContextKey, decodeAgentContextResource, isAgentContextGroup, decodeAgentContextPreview, type AgentContextConversation, type AgentContextPreview, type AgentContextSelection, type AgentContextText } from "@research-assistant/core/agent";
import { getAiAssistanceGateway } from "@research-assistant/workbench-preview/ai-assistance-gateway";
import { notePageId } from "@research-assistant/core/notes";
import type { AgentContextGateway } from "@research-assistant/workbench-preview/agent-context-gateway";
import { getLiteratureGateway } from "@research-assistant/literature-library-preview";
import { getNotesGateway } from "@research-assistant/workbench-preview/gateways-gateway";
import { getWritingGateway } from "../../../../../src/public/writingGateway.ts";
import { WritingDiffDemoHistory } from "@research-assistant/workbench-preview/writing-diff-demo-history";
import { WritingDemoSingleText } from "@research-assistant/workbench-preview/writing-demo-single-text";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
import type { WritingSubmissionAdmission } from "@research-assistant/workbench-preview/writing-submission-controller";
import type { PreviewControls } from "@research-assistant/workbench-preview/app-runtime";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";
import { mockContextGrants } from "./mockContextGrants";
import { mockContextCatalog,mockContextRecommendation } from "./mockContextCatalog";
import { mockSourceCitations } from "./mockSourceCitations";
import {MockConversationQueue} from "./MockConversationQueue";
import type { MockInternalTurnResult } from "./mockInternalToolStep";
import { MockRenameReceipts } from "@research-assistant/workbench-preview/mock-rename-receipts";
import { MockArchiveReceipts } from "@research-assistant/workbench-preview/mock-archive-receipts";
import { MockDeletionReceipts } from "@research-assistant/workbench-preview/mock-deletion-receipts";
import {MockIndependentReceipts} from "./mockIndependentReceipts";
import type { MockConversationDeletionPlan } from "@research-assistant/workbench-preview/mock-conversation-deletion-batch";
import type { AgentDeletionRequest } from "@research-assistant/core/agent";
export interface MockIndependentResponse {
    supports(preview: AgentContextPreview): boolean;
    run(preview: AgentContextPreview, history: WritingDiffDemoHistory, admission: WritingSubmissionAdmission, signal: AbortSignal): Promise<void>;
}
/** Synthetic source, submission and journal I/O for the production independent UI. */
export class MockIndependentAgents {
    private readonly history = new WritingDiffDemoHistory();
    private readonly conversations: Map<string, AgentContextConversation>;
    private readonly metadataRows = new Map<string,AgentConversationSummary>();
    private readonly deletionReceipts = new Map<string,string>();
    foreignOperationExists: (id: string) => boolean = () => false;
    private readonly renames: MockRenameReceipts = new MockRenameReceipts(id => this.archiveReceipts.has(id) || this.managedDeletions.has(id) || this.foreignOperationExists(id));
    private readonly archiveReceipts: MockArchiveReceipts = new MockArchiveReceipts(() => this.renames.epochId(), id => this.renames.has(id) || this.managedDeletions.has(id) || this.foreignOperationExists(id));
    private readonly managedDeletions: MockDeletionReceipts = new MockDeletionReceipts(() => this.renames.epochId(), id => this.renames.has(id) || this.archiveReceipts.has(id) || this.foreignOperationExists(id));
    private readonly previews: Map<string, AgentContextPreview>;
    private readonly queue: MockConversationQueue;
    private readonly preparationReceipts: MockIndependentReceipts;
    private readonly running = new Map<string, {
        admission: WritingSubmissionAdmission;
        timer: ReturnType<typeof setTimeout>;
        controller?: AbortController;
    }>();
    constructor(private readonly storage: Storage, private readonly controls: PreviewControls,
      private readonly respond?: MockIndependentResponse) {
        this.conversations = new Map(JSON.parse(storage.getItem("independent-conversations") ?? "[]") as [
            string,
            AgentContextConversation
        ][]);
        this.previews = new Map(JSON.parse(storage.getItem("independent-submissions") ?? "[]") as [
            string,
            AgentContextPreview
        ][]);
        for(const [id,row] of JSON.parse(storage.getItem("independent-metadata")??"[]") as [string,AgentConversationSummary][])this.metadataRows.set(id,row);
        for(const [id,value] of JSON.parse(storage.getItem("independent-deletions")??"[]") as [string,string][])this.deletionReceipts.set(id,value);
        const renames = storage.getItem("independent-renames");
        if (renames) this.renames.restore(decodeMockState(renames));
        else storage.setItem("independent-renames", encodeMockState(this.renames.snapshot()));
        const archives = storage.getItem("independent-archives");
        if (archives) this.archiveReceipts.restore(decodeMockState(archives));
        const deletions = storage.getItem("independent-managed-deletions");
        this.managedDeletions.restore(deletions ? decodeMockState(deletions) : undefined, this.deletionReceipts);
        const history = storage.getItem("independent-history");
        if (history)
            this.history.restore(decodeMockState(history));
        this.history.onChange = () => storage.setItem("independent-history", encodeMockState(this.history.snapshot()));
        this.history.interruptUnfinished();
        this.queue = new MockConversationQueue(storage, async id => {if ((await this.summary(id)).archived) throw {code:"closed"};}, this.renames.epochId());
        this.preparationReceipts = new MockIndependentReceipts(storage, request => this.gateway.prepare(request),
            (preview, resumeQueue) => this.gateway.start(preview, {resumeQueue}), id => this.history.snapshot().events.get(id) ?? [], this.renames.epochId(),
            preview => this.queue.isAdmitted(preview));
    }
    private save(): void { this.storage.setItem("independent-conversations", JSON.stringify([...this.conversations])); this.storage.setItem("independent-submissions", JSON.stringify([...this.previews]));this.storage.setItem("independent-metadata",JSON.stringify([...this.metadataRows]));this.storage.setItem("independent-deletions",JSON.stringify([...this.deletionReceipts]));this.storage.setItem("independent-renames",encodeMockState(this.renames.snapshot()));this.storage.setItem("independent-archives",encodeMockState(this.archiveReceipts.snapshot()));this.storage.setItem("independent-managed-deletions",encodeMockState(this.managedDeletions.snapshot())); }
    /** Completed mock journal, consumed by the production history and message views. */
    async seedConversation(preview: AgentContextPreview, title: string, response: string, internal = false, result?: MockInternalTurnResult): Promise<void> {
        if (this.has(preview.conversationId)) return;
        await this.gateway.sessions.create(preview.conversationId);
        this.recordInternalTurn(preview, response, result);
        this.conversations.set(preview.conversationId, {conversationId: preview.conversationId, title});
        const row = await this.summary(preview.conversationId);
        if (internal) this.metadataRows.set(preview.conversationId, {...row, internal: true});
        this.save();
    }
    async appendInternalTurn(preview: AgentContextPreview, response: string, result?: MockInternalTurnResult): Promise<void> {
        await this.assertInternalAvailable(preview.conversationId);
        if (this.previews.has(preview.requestId)) return;
        this.recordInternalTurn(preview, response, result);
        await this.summary(preview.conversationId);
        this.save();
    }
    /** Check before executing mock resource side effects, as at native admission. */
    async assertInternalAvailable(conversationId: string): Promise<void> {
        const row = await this.summary(conversationId);
        if (!row.internal || row.archived) throw new Error("内部对话不可用，请先恢复该对话。");
        this.history.assertIdle(conversationId);
    }
    private recordInternalTurn(preview: AgentContextPreview, response: string, result?: MockInternalTurnResult): void {
        this.previews.set(preview.requestId, structuredClone(preview));
        const admission: WritingSubmissionAdmission = {scope: {manuscriptId: "independent", conversationId: preview.conversationId, requestId: preview.requestId, contextSnapshotId: preview.contextSnapshotId}, turnId: preview.turnId};
        this.history.start(admission, preview.input.text, preview.input.model);
        for (const step of result?.steps ?? []) this.history.toolStep(admission, step);
        const itemId = crypto.randomUUID();
        this.history.feedbackEvents(admission, [
            {type: "itemStarted", turnId: preview.turnId, itemId, kind: {type: "assistantMessage"}},
            {type: "textDelta", turnId: preview.turnId, itemId, text: response},
            {type: "itemCompleted", turnId: preview.turnId, itemId},
        ]);
        if (result?.outcome && result.outcome !== "completed") this.history.finish(admission, result.outcome);
        else this.history.complete(admission, [], true);
    }
    readonly gateway: AgentContextGateway = {
        preparation: {
            proven: {prepare: (request, options) => this.preparationReceipts.proven.prepare(request, options)},
            status: {read: (request, options) => this.preparationReceipts.status.read(request, options)},
        },
        guardedStart: {
            start: (request, epoch) => this.preparationReceipts.guardedStart.start(request, epoch),
            read: (request, epoch) => this.preparationReceipts.guardedStart.read(request, epoch),
        },
        queue: {
            read: scope => this.queue.gateway.read(scope),
            edit: request => this.queue.gateway.edit(request),
        },
        recoverQueue: async id => {
            if ((await this.summary(id)).archived) throw "conversationUnavailable";
            const head=this.queue.read(id).preparingInputId;
            const preview=[...this.previews.values()].find(preview=>preview.conversationId===id&&preview.queue?.inputId===head);
            return preview ? this.gateway.restore(preview) : null;
        },
        catalog: mockContextCatalog,
        recommend:mockContextRecommendation,
        sessions: {
            ...this.history.gateway,
            create: async (id) => { await this.controls.beforeOperation("agent"); if (!this.conversations.has(id)) {
                this.conversations.set(id, { conversationId: id, title: "新对话" });
                this.save();
            } return this.history.gateway.create(id); },
            open: async (id) => { if (!this.conversations.has(id))
                throw new Error("独立对话不存在"); return this.history.gateway.open(id); },
        },
        list: async () => { await this.controls.beforeOperation("agent"); return [...this.conversations.values()].reverse(); },
        search: async (query) => {
            await this.controls.beforeOperation("agent");
            const selections: AgentContextSelection[] = [];
            const papers = await getLiteratureGateway().list();
            for (const paper of papers)
                for (const attachment of paper.attachments) {
                    if (attachment.mimeType === "application/pdf")
                        selections.push({ resource: { kind: "paper", resourceId: paper.id, attachmentId: attachment.id }, label: `${paper.title} · ${attachment.displayName}` });
                }
            const notes = await getNotesGateway().listPages();
            for (const note of notes)
                selections.push({ resource: { kind: "note", resourceId: note.id }, label: `笔记 · ${note.title}` });
            for (const manuscript of await getWritingGateway().listManuscripts())
                for (const file of await getWritingGateway().listFiles(manuscript.id))
                    if (["tex", "bib", "style"].includes(file.kind))
                        selections.push({ resource: { kind: "manuscriptFile", resourceId: manuscript.id, path: file.relativePath }, label: `${manuscript.title} · ${file.relativePath}` });
            return selections.filter(s => s.label.toLowerCase().includes(query.toLowerCase())).slice(0, 180);
        },
        prepare: async (request) => {
            await this.controls.beforeOperation("agent");
            if (!this.conversations.has(request.conversationId) || (await this.summary(request.conversationId)).archived)
                throw new Error("独立对话不存在");
            const context = await mockContextGrants(request.resources);
            const preview = decodeAgentContextPreview({ schemaVersion: 1, conversationId: request.conversationId, requestId: request.requestId, turnId: crypto.randomUUID(), contextSnapshotId: crypto.randomUUID(), input: { text: request.text, model: { providerId: request.model?.providerId ?? "deepseek", modelId: request.model?.modelId ?? "deepseek-v4-pro", revision: "preview-v1" }, reasoningEffort: request.model?.reasoningEffort ?? null, context, userInput:request.userInput??[] } });
            const frozen = request.queue ? {...preview,queue:this.queue.claim(preview,request.queue)} : preview;
            this.previews.set(request.requestId, structuredClone(frozen));
            this.save();
            return frozen;
        },
        restore: async (receipt) => { const preview = this.previews.get(receipt.requestId); if (!preview || preview.conversationId !== receipt.conversationId)
            throw new Error("冻结提交不存在"); const queue=this.queue.confirmation(preview);return structuredClone({...preview,...(queue?{queue}:{})}); },
        start: async (preview, options) => {
            await this.controls.beforeOperation("agent");
            if((await this.summary(preview.conversationId)).archived)throw "conversationUnavailable";
            const frozen = await this.gateway.restore(preview);
            if (frozen.contextSnapshotId !== preview.contextSnapshotId)
                throw new Error("confirmationMismatch");
            const prior = this.history.snapshot().admissions.get(JSON.stringify([preview.conversationId, preview.turnId]));
            if (prior) {
                const finished = this.history.snapshot().finished.has(JSON.stringify([preview.conversationId, preview.turnId]));
                return { schemaVersion: 1, conversationId: preview.conversationId, requestId: preview.requestId, turnId: preview.turnId, alreadyStarted: true, outcome: finished ? "completed" : null };
            }
            this.history.assertIdle(preview.conversationId);
            if (!!frozen.queue !== !!preview.queue) throw "confirmationMismatch";
            this.queue.admit(preview, options?.resumeQueue);
            this.queue.requireStartable(preview);
            const admission: WritingSubmissionAdmission = { scope: { manuscriptId: "independent", conversationId: preview.conversationId, requestId: preview.requestId, contextSnapshotId: preview.contextSnapshotId }, turnId: preview.turnId };
            this.history.start(admission, frozen.input.text, frozen.input.model);
            const row=await this.summary(preview.conversationId);this.metadataRows.set(row.id,{...row,updatedAt:new Date().toISOString()});
            this.save();
            const response = this.respond;
            if (response?.supports(frozen)) {
                const controller = new AbortController();
                const timer = setTimeout(() => {
                    void response.run(frozen, this.history, admission, controller.signal).then(() => {
                        if (!controller.signal.aborted) this.history.complete(admission, [], true);
                    }).catch(() => {
                        if (!controller.signal.aborted) this.history.finish(admission, "failed");
                    }).finally(() => {
                        if (this.running.get(preview.conversationId)?.controller === controller) this.running.delete(preview.conversationId);
                    });
                }, Math.max(100, this.controls.delayMs));
                this.running.set(preview.conversationId, { admission, timer, controller });
                return { schemaVersion: 1, conversationId: preview.conversationId, requestId: preview.requestId, turnId: preview.turnId, alreadyStarted: false, outcome: null };
            }
            const citations = mockSourceCitations(frozen.input.userInput ?? []);
            const stream = new WritingDemoSingleText(`本轮已读取 ${frozen.input.context.length} 项上下文。这是用于验证独立对话与材料选择的模拟回复。${citations ? `\n\n来源：${citations}` : ""}`);
            const step = () => { stream.next(this.history, admission); if (!stream.remainingSteps) {
                this.history.complete(admission, [], true);
                this.running.delete(preview.conversationId);
                return;
            } this.running.set(preview.conversationId, { admission, timer: setTimeout(step, 50) }); };
            this.running.set(preview.conversationId, { admission, timer: setTimeout(step, Math.max(100, this.controls.delayMs)) });
            return { schemaVersion: 1, conversationId: preview.conversationId, requestId: preview.requestId, turnId: preview.turnId, alreadyStarted: false, outcome: null };
        },
        interrupt: async (id) => { const running = this.running.get(id); if (running) {
            this.queue.pause(id);
            clearTimeout(running.timer);
            running.controller?.abort();
            this.history.finish(running.admission, "canceled");
            this.running.delete(id);
        } },
    };
    async materialize(resources:readonly import("@research-assistant/core/agent").AgentContextResource[]):Promise<AgentContextText[]>{
            const context: AgentContextText[] = [];
            for (const input of resources) {
                const resource = decodeAgentContextResource(input);
                if (isAgentContextGroup(resource)) {
                    const current = (await mockContextCatalog("")).find(item => agentContextKey(item.resource) === agentContextKey(resource));
                    if (!current || !isAgentContextGroup(current.resource)) throw new Error("sourceUnavailable");
                    const members = new Set(current.resource.parts.map(part => agentContextKey(part.resource)));
                    if (!resource.newMemberAccess && resource.parts.some(part => !members.has(agentContextKey(part.resource)))) throw new Error("sourceUnavailable");
                    for (const part of agentContextGroupParts(current.resource,resource).filter(part => part.selected)) {
                        for (const source of await this.materialize([part.resource])) context.push({...source, anchor: JSON.stringify({...JSON.parse(source.anchor ?? "{}"), contextAccess: part.access, contextOwner: {kind:resource.kind === "paperGroup" ? "paper" : resource.kind === "noteGroup" ? "note" : "manuscript", resourceId:resource.resourceId}})});
                    }
                }
                else if (resource.kind === "structuredObject") {
                    const object=await getStructuredResourceGateway().get(resource.resourceId);
                    const text=JSON.stringify(object.content);
                    context.push({sourceId:object.sourceUri,kind:"paper",resourceId:object.id,revision:String(object.revision),anchor:JSON.stringify({content:object.kind,contextAccess:resource.access??"readOnly"}),text});
                } else if(resource.kind === "templateCatalog") {
                    context.push({sourceId:`source://agents/skills/edit-structured-resources/assets/reading`,kind:"paper",resourceId:resource.resourceId,revision:"catalog",anchor:JSON.stringify({content:"templateCatalog",contextAccess:resource.access??"readOnly"}),text:"Managed template creation directory"});
                }
                else if (resource.kind === "paperNotes") {
                    const notes=(await getNotesGateway().listReadingNotes()).filter(note => note.source.paperId === resource.resourceId && note.pageId).map(note => note.pageId!);
                    const pages=(await getNotesGateway().listLiteratureNotes(resource.resourceId)).map(note => note.page.id);
                    for (const id of new Set([...notes,...pages])) if (!resource.excludedNoteIds.includes(id)) context.push(...await this.materialize([{kind:"note",resourceId:id}]));
                }
                else if (resource.kind === "paperMetadata" || resource.kind === "paperPortrait") {
                    const paper = await getLiteratureGateway().get(resource.resourceId);
                    const {attachments, ...metadata} = paper;
                    const text = resource.kind === "paperMetadata" ? JSON.stringify(metadata) : JSON.stringify({portraits:(await getAiAssistanceGateway().listCandidates()).filter(candidate => candidate.candidateKind === "paper_portrait_v1" && candidate.evidenceBundle.items.length > 0 && candidate.evidenceBundle.items.every(source => source.paperId === paper.id)).map(candidate => ({reviewState:candidate.reviewState,payload:candidate.revisions.find(value => value.revision === candidate.currentRevision)?.payload}))});
                    const role = resource.kind === "paperMetadata" ? "metadata" : "portrait";
                    context.push({sourceId:`paper:${paper.id}:${role}`,kind:"paper",resourceId:paper.id,revision:`sha256:${await writingDiffDemoHash(text)}`,anchor:JSON.stringify({content:role}),text});
                }
                else if (resource.kind === "paper") {
                    const paper = await getLiteratureGateway().get(resource.resourceId), attachment = paper.attachments.find(a => resource.attachmentId ? a.id === resource.attachmentId : a.mimeType === "application/pdf");
                    if (!attachment)
                        throw new Error("sourceUnavailable");
                    // The preview PDF is synthetic; use its fixture metadata as mocked text I/O.
                    const text = `${paper.title}\n${paper.abstractText}`;
                    context.push({ sourceId: `paper:${attachment.id}:page:${resource.pageIndex ?? 0}`, kind: "paper", resourceId: paper.id, revision: `sha256:${await writingDiffDemoHash(text)}`, anchor: JSON.stringify({ attachmentId: attachment.id, pageIndex: resource.pageIndex ?? 0, title: paper.title, content: "mockIndexedText" }), text });
                }
                else if (resource.kind === "note") {
                    const saved = await getNotesGateway().loadDocument(notePageId(resource.resourceId)), text = JSON.stringify({ page: saved.page, blocks: saved.document.blocks });
                    context.push({ sourceId: `note:${resource.resourceId}`, kind: "note", resourceId: resource.resourceId, revision: `sha256:${await writingDiffDemoHash(text)}`, anchor: null, text });
                }
                else if (resource.kind === "manuscriptFile") {
                    const saved = await getWritingGateway().readFile(resource.resourceId, resource.path);
                    context.push({ sourceId: `writing:${await writingDiffDemoHash(`${resource.resourceId}/${resource.path}`)}`, kind: "manuscript", resourceId: resource.path, revision: `sha256:${await writingDiffDemoHash(saved.content)}`, anchor: JSON.stringify({ manuscriptId: resource.resourceId, path: resource.path }), text: saved.content });
                }
            }
        return [...new Map(context.map(source => [source.sourceId,source])).values()];
    }
    async releaseConversation(id:string){const summary=await this.summary(id);this.history.assertIdle(id);const history=this.history.snapshot();this.conversations.delete(id);this.metadataRows.delete(id);this.save();return {summary,history};}
    adoptConversation(id:string,data:{summary:AgentConversationSummary;history:ReturnType<WritingDiffDemoHistory["snapshot"]>}):void{const snapshot=this.history.snapshot();snapshot.events.set(id,data.history.events.get(id)??[]);for(const [key,value] of data.history.admissions)if(value.scope.conversationId===id)snapshot.admissions.set(key,value);for(const key of data.history.finished)if(snapshot.admissions.get(key)?.scope.conversationId===id)snapshot.finished.add(key);this.history.restore(snapshot);this.conversations.set(id,{conversationId:id,title:data.summary.title});this.metadataRows.set(id,data.summary);this.save();this.storage.setItem("independent-history",encodeMockState(snapshot));}
    inspectMessage(request: import("@research-assistant/workbench-preview/message-inspection-gateway").MessageInspectionRequest) {
        const events = this.history.inspectMessage(request);
        const preview = [...this.previews.values()].find(value => value.conversationId === request.conversationId && value.turnId === request.turnId);
        return { schemaVersion: 1 as const, ...request, events,
            userInput: this.history.isFirstUserMessage(request) ? structuredClone(preview?.input.userInput ?? []) : [],
            frozenSubmission: request.referencesOnly || !preview ? null : structuredClone({ requestId: preview.requestId, contextSnapshotId: preview.contextSnapshotId, input: preview.input }) };
    }
    has(id:string):boolean{return this.conversations.has(id);}
    deletedRequest(id:string):boolean{return this.deletionReceipts.has(id);}
    hasRenameOperation(id:string):boolean{return this.renames.has(id);}
    hasArchiveOperation(id:string):boolean{return this.archiveReceipts.has(id);}
    private async summary(id:string, readHistory=true):Promise<AgentConversationSummary>{const item=this.conversations.get(id);if(!item)throw "notFound";const prior=this.metadataRows.get(id),now=new Date().toISOString();const row={...(prior?.internal ? {internal: true} : {}),id,title:item.title,archived:prior?.archived??false,durableCount:readHistory?(await this.history.gateway.open(id)).watermark:prior?.durableCount??0,createdAt:prior?.createdAt??now,updatedAt:prior?.updatedAt??now};this.metadataRows.set(id,row);return row;}
    readonly metadata:AgentMetadataGateway={read:request=>this.summary(request.id)};
    readonly catalog:AgentCatalogGateway={
      activity: async ({binding}) => binding ? [] : [...this.conversations.keys()].filter(id => this.history.activeTurn(id))
        .map(id => ({id, internal: Boolean(this.metadataRows.get(id)?.internal)})),
      list:async request=>{const rows=(await Promise.all([...this.conversations.keys()].map(id=>this.summary(id)))).filter(r=>r.archived===request.archived && Boolean(r.internal)===Boolean(request.internal)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).filter(r=>!request.before||r.createdAt<request.before.createdAt||(r.createdAt===request.before.createdAt&&r.id<request.before.id));const conversations=rows.slice(0,request.limit),last=conversations.at(-1);this.save();return decodeAgentCatalogPage({schemaVersion:1,conversations,next:rows.length>conversations.length&&last?{id:last.id,createdAt:last.createdAt}:null});},
      rename: async request => {
        const frozenRequest = decodeAgentRenameRequest(request), replay = this.renames.lookup(frozenRequest);
        if (replay) return replay;
        await this.summary(frozenRequest.id);
        const proof = this.renames.apply(frozenRequest, frozen => {
          const current = this.metadataRows.get(frozen.id);
          if (!current || !this.conversations.has(frozen.id)) throw "notFound";
          if (current.title !== frozen.expectedTitle) throw "conflict";
          const next = decodeAgentRenameResponse({schemaVersion:1,conversation:{...current,title:frozen.title.trim(),updatedAt:new Date().toISOString()}}).conversation;
          this.conversations.set(next.id,{conversationId:next.id,title:next.title});
          this.metadataRows.set(next.id,next);
        });
        this.save(); return proof;
      },
      renameStatus: async request => this.renames.status(request),
    };
    readonly archives: AgentArchiveGateway = {
        setArchived: async input => {
            const request = decodeAgentArchiveRequest(input);
            const replay = this.archiveReceipts.lookup(request);
            if (replay) return replay;
            await this.summary(request.id, request.archived);
            const proof = this.archiveReceipts.apply(request, frozen => {
                const current = this.metadataRows.get(frozen.id);
                if (!current || !this.conversations.has(frozen.id)) throw "notFound";
                if (frozen.archived) {
                    this.history.assertIdle(frozen.id);
                    this.history.assertWatermark(frozen.id, frozen.expectedWatermark!);
                }
                if (current.archived !== frozen.archived) this.metadataRows.set(frozen.id,
                    {...current, archived: frozen.archived, updatedAt: new Date().toISOString()});
            });
            this.save(); return proof;
        },
        archiveStatus: async request => this.archiveReceipts.status(request),
    };
    async prepareBatchDeletion(request: AgentDeletionRequest): Promise<MockConversationDeletionPlan> {
        if (request.binding) throw "notFound";
        await this.summary(request.conversationId);
        const validate = () => {
            this.managedDeletions.validateWrite(request);
            if (this.managedDeletions.replay(request)) throw "conflict";
            const current = this.metadataRows.get(request.conversationId);
            if (!current || !this.conversations.has(current.id)) throw "notFound";
            if (!current.archived) throw "notArchived";
            if (current.title !== request.expectedTitle) throw "conflict";
            this.history.assertIdle(current.id);
            this.history.assertWatermark(current.id, request.expectedDurableCount);
        };
        validate();
        const conversations = structuredClone(this.conversations), metadata = structuredClone(this.metadataRows),
            previews = structuredClone(this.previews), receipts = structuredClone(this.deletionReceipts),
            managed = this.managedDeletions.snapshot(), history = this.history.snapshot();
        return {validate, publish: () => this.managedDeletions.apply(request, () => {
            this.history.deleteConversation(request.conversationId, request.expectedDurableCount);
            this.conversations.delete(request.conversationId); this.metadataRows.delete(request.conversationId);
            for (const [id, preview] of this.previews) if (preview.conversationId === request.conversationId) this.previews.delete(id);
            this.deletionReceipts.set(request.requestId, JSON.stringify(request));
        }), rollback: () => {
            this.conversations.clear(); for (const item of conversations) this.conversations.set(...item);
            this.metadataRows.clear(); for (const item of metadata) this.metadataRows.set(...item);
            this.previews.clear(); for (const item of previews) this.previews.set(...item);
            this.deletionReceipts.clear(); for (const item of receipts) this.deletionReceipts.set(...item);
            this.managedDeletions.restore(managed, receipts); this.history.restore(history);
        }, finish: () => {this.storage.setItem("independent-history", encodeMockState(this.history.snapshot())); this.save();}};
    }
    readonly deletions: AgentDeletionGateway = {
        status: async request => this.managedDeletions.status(request),
        delete: async (input, options) => {
            const precondition = options === undefined ? undefined : decodeAgentDeletionWriteOptions(options);
            const request = this.managedDeletions.validateWrite(input, precondition);
            if (request.binding) throw "notFound";
            if (!this.managedDeletions.replay(request)) {
                await this.summary(request.conversationId);
                this.managedDeletions.validateWrite(request, precondition);
                this.managedDeletions.apply(request, () => {
                    const current = this.metadataRows.get(request.conversationId);
                    if (!current || !this.conversations.has(current.id)) throw "notFound";
                    if (!current.archived) throw "notArchived";
                    if (current.title !== request.expectedTitle) throw "conflict";
                    this.history.deleteConversation(current.id, request.expectedDurableCount);
                    this.conversations.delete(current.id); this.metadataRows.delete(current.id);
                    for (const [id, preview] of this.previews) if (preview.conversationId === current.id) this.previews.delete(id);
                    this.deletionReceipts.set(request.requestId, JSON.stringify(request));
                });
                this.storage.setItem("independent-history", encodeMockState(this.history.snapshot())); this.save();
            }
            return decodeAgentDeletionResponse({schemaVersion: 1, requestId: request.requestId, conversationId: request.conversationId});
        },
    };
    readonly search:AgentSearchGateway={search:async request=>{const page=await this.catalog.list(request.scope);return decodeAgentSearchPage({schemaVersion:1,hits:page.conversations.filter(row=>row.title.toLocaleLowerCase().includes(request.term.toLocaleLowerCase())).map(conversation=>({conversation,excerpt:conversation.title,itemId:null,turnId:null,startSeq:null,completed:true})),next:page.next});}};
    readonly exports:AgentConversationExportGateway={snapshot:async()=>{throw new Error("预览暂不提供真实导出文件");},download:async id=>{const row=await this.summary(id);return {schemaVersion:1,conversationId:id,watermark:row.durableCount,destinationPath:"preview-downloads/"+row.title+".json",byteSize:0};}};
    dispose(): void { for (const value of this.running.values()) {
        clearTimeout(value.timer); value.controller?.abort();
    } this.running.clear(); this.history.dispose(); }
}
