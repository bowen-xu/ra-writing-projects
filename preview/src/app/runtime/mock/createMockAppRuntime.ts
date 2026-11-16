import { createMockNoteScenarios } from "./mockNoteScenarios";
import {configureResearchExport} from "@research-assistant/literature-library-preview";
import { createMockContextConfigurationAuthority } from "./mockContextConfigurationAuthority";
import {createMockNoteRecovery} from "./mockNoteRecovery";
import type {NoteRecoveryScenario} from "@research-assistant/workbench-preview/note-recovery-preview";
import {createMockSystemDocuments} from "./mockSystemDocuments";
import {createMockCodexCatalogVersions} from "./mockCodexCatalogVersions";
import {systemDocumentPreviewResponse} from "./systemDocumentPreviewResponse";
import { importMockStartupContexts } from "./importMockStartupContexts";
import { createMockStructuredResources } from "@research-assistant/literature-library-preview";
import { getNalQueryGateway } from "@research-assistant/literature-library-preview";
import { getNalGateway } from "@research-assistant/literature-library-preview";
import { mockContextGrants } from "./mockContextGrants";
import { createMockTextPatchGateway, TEXT_PATCH_PREVIEW_PAGE } from "./mockTextPatchGateway";
import { MockNoteTextSession } from "./MockNoteTextSession";
import {createBrowserNoteHbsAuthority} from "@research-assistant/workbench-preview/browser-note-hbs-authority";
import {publishBrowserNoteDraft} from "@research-assistant/workbench-preview/browser-note-draft";
import {disposeStructuredHbsSessions} from "@research-assistant/literature-library-preview";
import { seedTextPatchAppFixture, textPatchPreviewResponse } from "./textPatchAppFixture";
import { createMockConversationCatalog } from "./MockConversationCatalog";
import { createBrowserWordExplanationStore } from "@research-assistant/workbench-preview/word-explanation-store";
import { createMockGitGateways } from "./mockGitGateways";
import { MockResearchAgents } from "./MockResearchAgents";
import { MockIndependentAgents } from "./MockIndependentAgents";
import { createMockResearchQueues } from "./mockResearchQueues";
import {createBrowserWritingCheckpointGateway} from "../../../../fixtures/browserWritingCheckpointGateway";
import { createMockAgentResourceGateways } from "../../previews/agent/mockAgentResourceGateways";
import { MockAgentCommandGateway } from "@research-assistant/workbench-preview/mock-agent-command-gateway";
import { getDerivedResearchViewGateway } from "@research-assistant/literature-library-preview";
import { getLiteratureGateway } from "@research-assistant/literature-library-preview";
import { getProjectGateway } from "@research-assistant/workbench-preview/project-gateway";
import { getCollectionGateway } from "@research-assistant/literature-library-preview";
import { getNotesGateway } from "@research-assistant/workbench-preview/gateways-gateway";
import { getResearchKnowledgeGateway } from "@research-assistant/literature-library-preview";
import { getEvidenceGateway } from "@research-assistant/literature-library-preview";
import { getEvidenceMatrixGateway } from "@research-assistant/literature-library-preview";
import { getReferenceRecordGateway } from "@research-assistant/literature-library-preview";
import { getSemanticIndexGateway } from "@research-assistant/workbench-preview/semantic-index-gateway";
import { getContentStorageGateway } from "@research-assistant/workbench-preview/content-storage-gateway";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";
import { createPreviewControls } from "@research-assistant/workbench-preview/preview-controls";
import { selectAppRuntime, type AppRuntime } from "@research-assistant/workbench-preview/app-runtime";
import { createMockAiGateway } from "./mockAiGateway";
import { mockInternalConversations } from "./mockInternalConversations";
import { createMockDoclingGateway } from "@research-assistant/literature-library-preview";
import { createPreparedPaperGenerationGateway } from "@research-assistant/literature-library-preview";
import { createMockWritingGateway } from "./mockWritingGateway";
import { createMockLiteratureGateway } from "@research-assistant/literature-library-preview";
import { MockWritingAgents } from "./MockWritingAgents";
import {MockPlatformEvents} from "./MockPlatformEvents";
import { createMockBoundResourceReader } from "./mockBoundResourceAvailable";
import { monitorMockGateway } from "./mockOperations";
import { seedMockData } from "./mockSeed";
import { seedNoteIndexFixture } from "./seedNoteIndexFixture";
import { seedSourceNavigationFixture } from "./sourceNavigationFixture";
import { createMockEvidenceImages } from "./mockEvidenceImages";
import { writingRecoveryFixture } from "./writingRecoveryFixture";
import { flushStorage, storagePersistence } from "@research-assistant/workbench-preview/storage-persistence";
import type { WritingRecoveryScenario } from "@research-assistant/workbench-preview/writing-recovery-preview";

export async function createMockAppRuntime(storage: Storage, options: {readonly bibliographyPreview?: boolean; readonly sourceNavigation?: boolean; readonly textPatch?: boolean; readonly writingRecovery?: WritingRecoveryScenario; readonly noteRecovery?: NoteRecoveryScenario} = {}): Promise<AppRuntime> {
  let dispose: () => void = () => undefined;
  let disposed = false;
  const events = new MockPlatformEvents();
  const controls = createPreviewControls(storage, async () => {
    await flushStorage(storage);
    const persistence = storagePersistence(storage);
    if (persistence) await persistence.reset(dispose); else { dispose(); storage.clear(); }
    window.location.reload();
  });
  if (options.noteRecovery) controls.configure({delayMs: 0, nextFailure: null});
  const checkpoints = monitorMockGateway(createBrowserWritingCheckpointGateway(storage), controls);
  const writingSource = createMockWritingGateway(storage,options.bibliographyPreview);
  const writing = monitorMockGateway(writingSource, controls);
  const agents = new MockWritingAgents(storage, writing, checkpoints, controls, createMockBoundResourceReader(writing, getLiteratureGateway()));
  const research = new MockResearchAgents(storage, agents, controls);
  const textPatch = createMockTextPatchGateway(options.textPatch, storage);
  const notes = getNotesGateway();
  const noteHbs = createBrowserNoteHbsAuthority({
    legacyBaseline: id => {
      const review = textPatch.snapshot().review;
      return review && ["pending", "accept"].includes(review.state) ? review.pages.find(page => page.pageId === id)?.reviewDocument ?? undefined : undefined;
    },
    acknowledge: snapshot => textPatch.acknowledgeHbs(snapshot.saved, snapshot.baseline, snapshot.version),
  });
  const textSession = new MockNoteTextSession(notes, TEXT_PATCH_PREVIEW_PAGE, () => controls.beforeOperation("save"),
    (document, expectedRevision, review) => noteHbs.saveExternal({document, expectedRevision, saveReason: "structure"}, review?.baseline ?? document));
  if (options.textPatch) textPatch.connectHost(textSession);
  const noteScenarios = createMockNoteScenarios(textSession, textPatch, controls);
  const recovery = options.noteRecovery ? createMockNoteRecovery(storage, options.noteRecovery, notes, noteHbs) : undefined;
  const systemDocuments = createMockSystemDocuments(storage);
  const systemResponse = systemDocumentPreviewResponse(systemDocuments);
  const patchResponse = options.textPatch ? textPatchPreviewResponse(textPatch) : undefined;
  const independent = new MockIndependentAgents(storage, controls, {supports: p=>systemResponse.supports(p)||!!patchResponse?.supports(p), run:(...args)=>systemResponse.supports(args[0])?systemResponse.run(...args):patchResponse!.run(...args)});
  agents.unboundConversationExists = id => independent.has(id);
  agents.foreignOperationExists = id => independent.hasRenameOperation(id) || independent.hasArchiveOperation(id) || independent.deletedRequest(id);
  independent.foreignOperationExists = id => agents.hasOperation(id);
  agents.contextSources=async (resources,primaryManuscriptId)=>(await Promise.all(resources.map(resource => (resource.kind === "manuscript" || resource.kind === "manuscriptFile") && resource.resourceId === primaryManuscriptId ? independent.materialize([resource]) : mockContextGrants([resource])))).flat();
  const researchPorts = research.gateways(), writingPorts = agents.gateways();
  const resources = createMockAgentResourceGateways(storage);
  const commands = new MockAgentCommandGateway();
  const evidenceImages = createMockEvidenceImages(storage, { readNoteAsset: id => getNotesGateway().readNoteAsset(id) });
  const contextConfigurations = new Map<string,{revision:number;state:import("@research-assistant/core/agent").AgentContextState}>(decodeMockState(storage.getItem("native-context-configurations") ?? encodeMockState(new Map())));
  const structuredResources = createMockStructuredResources(storage, {importContexts: async contexts => {
    const writingConversations = new Set((await Promise.all([
      agents.listConversations(false), agents.listConversations(true),
    ])).flat().map(conversation => conversation.id));
    importMockStartupContexts(contextConfigurations, contexts, id => independent.has(id) || writingConversations.has(id));
    storage.setItem("native-context-configurations", encodeMockState(contextConfigurations));
  }});
  const docling = monitorMockGateway(createMockDoclingGateway(storage, controls), controls);
  const ai = createPreparedPaperGenerationGateway(mockInternalConversations(await createMockAiGateway(storage), independent, storage,structuredResources,(id,state)=>{if(!contextConfigurations.has(id)){contextConfigurations.set(id,{revision:1,state});storage.setItem("native-context-configurations",encodeMockState(contextConfigurations));}},id=>structuredClone(contextConfigurations.get(id)?.state)), () => docling);
  const unified = createMockConversationCatalog(independent, agents, writingPorts);
  const contextAuthority = await createMockContextConfigurationAuthority(storage, contextConfigurations, () => controls.beforeOperation("platform"),
    async id => { const metadata = await unified.agentMetadataGateway!.read({ id }); if (metadata.archived) throw "conversationUnavailable"; });
  const runtime: AppRuntime = {
    mode: "preview", storage, preview: controls, events,
    ...(options.textPatch ? { notePreview: noteScenarios.scenarios } : {}),
    ...(recovery ? {noteRecovery: recovery.preview} : {}),
    gateways: {
      codexCatalogVersionGateway: monitorMockGateway(createMockCodexCatalogVersions(storage), controls),
      getStructuredResourceGateway: structuredResources,
      getNalQueryGateway: monitorMockGateway(getNalQueryGateway(), controls),
      getNalGateway: monitorMockGateway(getNalGateway(), controls),
      textPatchGateway: textPatch,
      ...(options.textPatch ? { noteTextSessionGateway: textSession } : {}),
      getWordExplanationStore: monitorMockGateway(createBrowserWordExplanationStore(), controls),
      getWordExplanationGateway: { explain: async (request, signal) => {
        await controls.beforeOperation("word-explanation");
        signal?.throwIfAborted();
        const translations: Readonly<Record<string, string>> = { "the idea": "这一观点", work: "本研究", local: "本地的", "for a long time": "长期以来" };
        return { translation: translations[request.word.toLowerCase()] ?? "此处的具体含义（预览示例）", explanation: `“${request.word}”需要结合所在句子的用法理解。这是模拟解释，未调用模型。`, providerId: "fixture-generation", modelId: "mock-word-explanation" };
      }, followUp: async (request, signal) => {
        await controls.beforeOperation("word-follow-up"); signal?.throwIfAborted();
        return { text: `模拟回答：关于“${request.context.word}”，应结合相邻句子确认其用法。这是局部追问预览，未调用模型。`, providerId: "fixture-generation", modelId: "mock-word-explanation" };
      } },
      agentContextGateway: {...independent.gateway,
        steeringHandoff: agents.steeringHandoff,
        ...contextAuthority,
        subscribeConfiguration:async(_id,changed)=>{window.addEventListener("research-assistant:structured-resource-changed",changed);return()=>window.removeEventListener("research-assistant:structured-resource-changed",changed);},
        readConfiguration:async id => structuredClone(contextConfigurations.get(id) ?? null),
        saveConfiguration:async(id,expectedRevision,state)=>{const previous=contextConfigurations.get(id);if((previous?.revision??0)!==expectedRevision)throw new Error("confirmationMismatch");const next={revision:expectedRevision+1,state:structuredClone(state)};contextConfigurations.set(id,next);storage.setItem("native-context-configurations",encodeMockState(contextConfigurations));return next;},
        sessions: {...unified.agentSessionGateway!, create: independent.gateway.sessions.create},
        preparation: {...independent.gateway.preparation!, proven: {prepare: async (request, options) => {
          if (!independent.has(request.conversationId)) await agents.moveConversation(request.conversationId, null, independent);
          return independent.gateway.preparation!.proven.prepare(request, options);
        }}},
        prepare: async request => {
          if (!independent.has(request.conversationId)) await agents.moveConversation(request.conversationId, null, independent);
          return independent.gateway.prepare(request);
        },
      },
      getDerivedResearchViewGateway: monitorMockGateway(getDerivedResearchViewGateway(), controls),
      ...createMockGitGateways(storage, writing),
      agentCommandGateway: commands,
      getLiteratureGateway: monitorMockGateway(createMockLiteratureGateway(getLiteratureGateway(), storage), controls),
      getProjectGateway: monitorMockGateway(getProjectGateway(), controls), getCollectionGateway: monitorMockGateway(getCollectionGateway(), controls),
      getNotesGateway: monitorMockGateway({ ...notes,
        commitNavigation: async request => {
          const writesFixture = request.documents.some(save => save.document.pageId === TEXT_PATCH_PREVIEW_PAGE);
          const review = textPatch.snapshot().review;
          if (options.textPatch && writesFixture && review?.state === "pending" && review.pages.some(page => (page.chunks?.length ?? 0) > 0 || page.metadataPending))
            throw new Error("请先完成修改审阅，再移动页面链接。");
          const results = await notes.commitNavigation(request);
          const saved = results.find(value => value.page.id === TEXT_PATCH_PREVIEW_PAGE);
          if (options.textPatch && writesFixture && saved) textPatch.retire(saved.document);
          return results;
        },
        resolveConflict: async request => {
          const apply = () => noteScenarios.resolve(async () => {
            const receipt = await notes.resolveConflict(request);
            if (options.textPatch && receipt.original.page.id === TEXT_PATCH_PREVIEW_PAGE) textPatch.retire(receipt.original.document);
            return receipt;
          });
          return apply();
        },
        restoreRevision: async (pageId, revisionId, expectedRevision) => {
          const saved = await notes.restoreRevision(pageId, revisionId, expectedRevision);
          if (options.textPatch && pageId === TEXT_PATCH_PREVIEW_PAGE) textPatch.retire(saved.document);
          return saved;
        },
        saveDocument: async request => {
          const saved = await notes.saveDocument(request);
          if (options.textPatch && request.document.pageId === TEXT_PATCH_PREVIEW_PAGE) textPatch.edit(saved.document);
          return saved;
        },
        exportNotes: async request => ({ folderName: request.folderName, fileCount: request.files.length, assetCount: request.assets.length }), cancelNoteExport: async () => true }, controls), getResearchKnowledgeGateway: monitorMockGateway(getResearchKnowledgeGateway(), controls),
      getEvidenceGateway: monitorMockGateway(getEvidenceGateway(), controls), getEvidenceMatrixGateway: monitorMockGateway(getEvidenceMatrixGateway(), controls),
      getReferenceRecordGateway: monitorMockGateway(getReferenceRecordGateway(), controls), getSemanticIndexGateway: monitorMockGateway(getSemanticIndexGateway(), controls),
      getContentStorageGateway: monitorMockGateway(getContentStorageGateway(), controls), getDoclingGateway: docling,
      getAiAssistanceGateway: monitorMockGateway(ai, controls), getWritingGateway: writing, getWritingCheckpointGateway: checkpoints,
      ...writingPorts, ...researchPorts, ...createMockResearchQueues(agents, researchPorts, research.paperReceipts), ...unified,
      agentTurnGateway: { interrupt: async request => { if (await research.interrupt(request.conversationId)) return { schemaVersion: 1, ...request, cancellationRequested: true }; return writingPorts.agentTurnGateway!.interrupt(request); } },
      agentMcpGateway: resources.tools, agentSkillCatalogGateway: resources.skills,
    },
    invoke: async (command, args) => {
      if(command === "publish_note_draft") {
        await controls.beforeOperation("save");
        const id=String(args?.resourceId), apply=()=>publishBrowserNoteDraft(id,args?.request as import("@research-assistant/data/notes").NoteDraftCommit);
        return recovery ? recovery.invoke("hbs_commit_document",id,apply) : apply();
      }
      if(command==="system_documents_pending") return systemDocuments.gateway.pending(String(args?.conversationId));
      if (command.startsWith("hbs_")) {
        await controls.beforeOperation(command === "hbs_commit_document" ? "save" : "platform");
        const id = String(args?.resourceId), authority = args?.kind === "note" ? noteHbs : args?.kind === "structured" ? structuredResources.hbs : undefined;
        if (!authority) throw Object.assign(new Error("MODEL_INVALID_KIND：未知文档类型。"), {code: "MODEL_INVALID_KIND"});
        const apply = async () => {
          if (command === "hbs_read_document") return authority.read(id);
          if (command === "hbs_commit_document") return authority.commit(id, args?.request as import("@research-assistant/core/hbs").DocumentCommit<unknown>);
          if (command === "hbs_read_preservation") return authority.readPreservation(id);
          if (command === "hbs_save_preservation") return authority.savePreservation(id, args?.checkpoint);
          throw new Error(`MODEL_INVALID_COMMAND：不支持的 HBS 平台调用 ${command}`);
        };
        return recovery && args?.kind === "note" ? recovery.invoke(command, id, apply) : apply();
      }
      await controls.beforeOperation("platform");
      if(command==="system_documents_list") return systemDocuments.gateway.list();
      if(command==="system_documents_read") return systemDocuments.gateway.read(String(args?.id));
      if(command==="system_documents_write") return systemDocuments.gateway.write(args?.input as import("@research-assistant/core/agent").SystemDocumentWrite);
      if(command==="system_documents_decide") return systemDocuments.gateway.decide(String(args?.conversationId),String(args?.requestId),args?.allow===true);
      if (evidenceImages.handles(command)) return evidenceImages.invoke(command, args);
      if(command==="agent_read_context_directory")return agents.contextDirectory(String(args?.conversationId));
      if(command==="agent_list_context_directories")return (await writing.listManuscripts()).filter(m=>m.status==="active").map(m=>({manuscriptId:m.id,title:m.title,path:m.id}));
      if(command==="agent_set_context_directory"){const request=args?.request as {conversationId:string;expectedDirectoryId:string|null;directoryId:string|null};const current=await agents.contextDirectory(request.conversationId);if((current?.manuscriptId??null)!==request.expectedDirectoryId)throw "conflict";const metadata=await unified.agentMetadataGateway!.read({id:request.conversationId});if(metadata.archived)throw "conflict";return agents.moveConversation(request.conversationId,request.directoryId,independent);}
      if (command === "agent_read_message_data") {
        const request = args?.request as Parameters<typeof agents.inspectMessage>[0];
        return independent.has(request.conversationId) ? independent.inspectMessage(request) : agents.inspectMessage(request);
      }
      if (command === "agent_read_skill_document") return resources.readSkillDocument?.(args?.identity as Parameters<NonNullable<typeof resources.readSkillDocument>>[0]);
      if (command === "export_research_knowledge") return { folderName: "preview-export", fileCount: 1, objectCount: 1, sourceCount: 1 };
      if (command === "cancel_research_export") return true;
      if (command === "agent_list_host_resources") return [];
      if (command === "agent_list_execution_hosts") return [];
      if (command === "agent_read_mcp_configuration") return mockMcpText(storage);
      if (command === "agent_save_mcp_configuration") { if (args?.expectedText !== mockMcpText(storage)) throw new Error("配置已变化，请重新载入后重试。"); storage.setItem("mcp-config", String(args?.text)); return; }
      if (["agent_set_mcp_credential", "agent_set_host_shell_authorization", "agent_cancel_skill_import", "agent_install_skill_import", "agent_remove_skill"].includes(command)) return;
      if (command === "agent_scan_skill_import") return { importId: crypto.randomUUID(), resolvedCommit: null, candidates: [{ sourceId: "mock/academic-writing/SKILL.md", name: "模拟写作技能", revision: "1", existingRevision: null }] };
      throw new Error(`预览未覆盖平台调用：${command}`);
    },
    dispose: () => { if (disposed) return; disposed = true; events.dispose(); void disposeStructuredHbsSessions(); controls.dispose(); commands.dispose(); independent.dispose(); research.dispose(); agents.dispose(); },
  };
  configureResearchExport(runtime);
  dispose = runtime.dispose;
  selectAppRuntime(runtime);
  await seedMockData(storage, writing);
  await seedNoteIndexFixture(storage, writingSource, notes);
  await agents.initialize();
  if (options.writingRecovery) Object.assign(runtime.gateways, await writingRecoveryFixture(storage, writing, runtime.gateways, options.writingRecovery));
  if (options.sourceNavigation) await seedSourceNavigationFixture(storage, independent, getNotesGateway(), writing);
  if (options.textPatch) {
    await seedTextPatchAppFixture(storage, independent, textPatch, notes);
    // Native IPC owns this bridge inside its DB transaction. In the browser
    // preview the legacy tool journal is a separate record; after reopening,
    // repair only its live projection from authoritative S/B. Frozen tool
    // snapshots/receipts remain unchanged, including after a lost ACK.
    const current = await noteHbs.read(TEXT_PATCH_PREVIEW_PAGE), shown = textPatch.snapshot();
    const page = shown.review?.pages.find(page => page.pageId === TEXT_PATCH_PREVIEW_PAGE);
    if (shown.revision !== current.version || JSON.stringify(shown.document) !== JSON.stringify(current.saved)
      || page && JSON.stringify(page.reviewDocument) !== JSON.stringify(current.baseline)) {
      textPatch.acknowledgeHbs(current.saved, current.baseline, current.version);
    }
  }
  await recovery?.prepare();
  return runtime;
}

function mockMcpText(storage: Storage): string {
  const text = storage.getItem("mcp-config") ?? "# 模拟 MCP 配置\n";
  return /^schema_version\s*=/m.test(text) ? text : "schema_version = 1\n" + text;
}
