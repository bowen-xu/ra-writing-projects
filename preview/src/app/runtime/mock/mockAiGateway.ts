import { mockPaperPortraitGateway } from "@research-assistant/literature-library-preview";
import type { AiAssistanceGateway } from "@research-assistant/workbench-preview/ai-assistance-gateway";
import type { LlmConfiguration, LlmModelRoute } from "@research-assistant/core/ai";
import { createWritingDemoModelGateway } from "@research-assistant/workbench-preview/writing-demo-model-gateway";

/** Missing AI scenarios report an explicit mock error; never use a provider. */
export function completeMockGateway<T extends object>(methods: Partial<T>, name: string): T {
  return new Proxy(methods, { get(target, property) {
    if (property === "then") return undefined;
    if (property in target) return Reflect.get(target, property);
    return async () => { throw new Error(`预览未覆盖调用：${name}.${String(property)}`); };
  } }) as T;
}
export async function createMockAiGateway(storage: Storage): Promise<AiAssistanceGateway> {
  const model = createWritingDemoModelGateway();
  const initial = await model.gateway.getLlmConfiguration();
  model.setMode("openai");
  const openai = await model.gateway.getLlmConfiguration();
  let configuration: LlmConfiguration = JSON.parse(storage.getItem("llm-configuration") ?? "null") as LlmConfiguration | null ?? {
    ...initial, providers: [...initial.providers, ...openai.providers],
  };
  const persist = () => { storage.setItem("llm-configuration", JSON.stringify(configuration)); return configuration; };
  let loggedIn = storage.getItem("chatgpt-login") === "true";
  const methods: Partial<AiAssistanceGateway> = {
    getLlmConfiguration: async () => configuration,
    fetchLlmProviderModels: providerId => model.gateway.fetchLlmProviderModels(providerId),
    saveLlmProviderConfig: async draft => { configuration = { ...configuration, providers: configuration.providers.map(provider => provider.providerId === draft.providerId ? { ...provider, ...draft, usesDefaultBaseUrl: draft.baseUrl === "" } : provider) }; return persist(); },
    saveLlmModelRoutes: async drafts => {
      const update = (routes: readonly LlmModelRoute[]) => routes.map(route => { const draft = drafts.find(item => item.routeKind === route.routeKind && item.routeId === route.routeId); if (!draft) return route; const { selection: _old, ...rest } = route; return { ...rest, ...(draft.selection ? { selection: draft.selection } : {}) }; });
      configuration = { ...configuration, defaultModels: update(configuration.defaultModels), useCases: update(configuration.useCases) }; return persist();
    },
    getChatGptAccountStatus: async () => ({ runtimeAvailable: true, configured: loggedIn, authType: "mock", ...(loggedIn ? { email: "preview@example.invalid", planType: "preview" } : {}) }),
    startChatGptLogin: async () => { loggedIn = true; storage.setItem("chatgpt-login", "true"); return { loginId: crypto.randomUUID(), authUrl: "about:blank" }; },
    cancelChatGptLogin: async () => true, logoutChatGpt: async () => { loggedIn = false; storage.setItem("chatgpt-login", "false"); return true; },
    setCredential: async draft => {
      configuration = { ...configuration, providers: configuration.providers.map(provider => provider.providerId === draft.providerId ? { ...provider, credentialConfigured: true, credentialMask: "模拟凭据" } : provider) }; persist();
      return { providerId: draft.providerId, configured: true, maskedValue: "模拟凭据" };
    },
    deleteCredential: async providerId => {
      configuration = { ...configuration, providers: configuration.providers.map(provider => provider.providerId === providerId ? { ...provider, credentialConfigured: false } : provider) }; persist();
      return { providerId, configured: false };
    },
    testProvider: async providerId => ({ providerId, modelId: "preview", reachable: true, message: "模拟连接成功；未连接真实服务。" }),
    listProviders: async () => [], listRuns: async () => [], listCandidates: async () => [], listPaperReadingSessions: async () => [],
    getLatestPaperAnalysisWorkflow: async () => undefined,
    cancelRun: async () => true, cancelConceptRetrievalPreview: async () => true,
  };
  return completeMockGateway({ ...methods, ...mockPaperPortraitGateway(storage) }, "AI");
}
