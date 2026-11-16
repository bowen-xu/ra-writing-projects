import {previewSkillSources} from "@research-assistant/workbench-preview/preview-assets";
const {portrait, editing, portraitReference, readingReference, templatesReference} = previewSkillSources;
import {systemDocumentPath} from "@research-assistant/core/agent";
import task from "@research-assistant/core/prompts/structured-task.md?raw";
import contract from "@research-assistant/core/prompts/structured-reading-contract.md?raw";
import { PromptTemplate, type SystemDocument, type SystemDocumentApproval, type SystemDocumentGateway } from "@research-assistant/core/agent";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
const CATALOG = [
    { id: "structured-task", name: "阅读任务提示词.md", workflow: "shared", content: task },
    { id: "structured-reading-contract", name: "结构化阅读格式.md", workflow: "reading", content: contract },
    { id: "generate-paper-portrait", name: "文献画像技能 · SKILL.md", workflow: "portrait", content: portrait },
    { id: "edit-structured-resources", name: "结构化资源技能 · SKILL.md", workflow: "shared", content: editing },
    { id: "portrait-reference", name: "画像格式 · portrait.md", workflow: "portrait", content: portraitReference },
    { id: "reading-reference", name: "阅读格式 · reading.md", workflow: "reading", content: readingReference },
    { id: "templates-reference", name: "模板格式 · templates.md", workflow: "shared", content: templatesReference },
] as const;
const KEY = "builtin-documents.v1";
type Entry = {
    content: string;
    baseline: string;
};
function validate(id: string, text: string): void {
    if (!CATALOG.some(row => row.id === id) || !text.trim() || new TextEncoder().encode(text).length > 131072 || text.includes("\0"))
        throw new Error("内置文档格式无效");
    if (id === "structured-task")
        PromptTemplate.parse(text).render([["task", ""], ["contract", ""], ["preferences", ""]]);
    if (id === "structured-reading-contract")
        PromptTemplate.parse(text).render([["schema", ""]]);
    if (id === "generate-paper-portrait" || id === "edit-structured-resources") {
        if (!text.startsWith("---\n") || !new RegExp(`^name: ${id}$`, "mu").test(text) || !/^description: .+$/mu.test(text))
            throw new Error("请保留内置技能的 name 与 description");
    }
}
function entries(storage: Storage): Record<string, Entry> {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("内置文档存储无效");
    for (const [id, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object" || typeof value.content !== "string" || typeof value.baseline !== "string")
            throw new Error("内置文档存储无效");
        validate(id, value.content);
        validate(id, value.baseline);
    }
    return raw as Record<string, Entry>;
}
export async function readMockSystemDocument(storage: Storage, id: string): Promise<SystemDocument> {
    const row = CATALOG.find(value => value.id === id);
    if (!row)
        throw new Error("内置文档不存在");
    const entry = entries(storage)[id] ?? { content: row.content, baseline: row.content };
    return { ...row, ...entry, path: systemDocumentPath(id)!, revision: await writingDiffDemoHash(`${entry.content}\0${entry.baseline}`) };
}
/** Mock only persistence and the pending host decision, keeping real assets and production UI. */
export function createMockSystemDocuments(storage: Storage) {
    const requests = new Map<string, {
        request: SystemDocumentApproval;
        resolve: (allow: boolean) => void;
    }>();
    const gateway: SystemDocumentGateway = {
        list: () => Promise.all(CATALOG.map(row => readMockSystemDocument(storage, row.id))),
        read: id => readMockSystemDocument(storage, id),
        write: async (input) => {
            validate(input.id, input.content);
            validate(input.id, input.baseline);
            const current = await readMockSystemDocument(storage, input.id);
            if (current.revision !== input.expectedRevision)
                throw new Error("文档已变化，请重新读取；本地编辑已保留");
            storage.setItem(KEY, JSON.stringify({ ...entries(storage), [input.id]: { content: input.content, baseline: input.baseline } }));
            return readMockSystemDocument(storage, input.id);
        },
        pending: async (conversationId) => [...requests.values()].filter(row => row.request.conversationId === conversationId).map(row => row.request),
        decide: async (conversationId, id, allow) => {
            const pending = requests.get(id);
            if (!pending || pending.request.conversationId !== conversationId)
                throw new Error("写入请求已结束或不属于当前对话");
            requests.delete(id);
            pending.resolve(allow);
        },
    };
    return { gateway, async requestWrite(conversationId: string, id: string, after: string, signal: AbortSignal) {
            signal.throwIfAborted();
            validate(id, after);
            const document = await gateway.read(id);
            signal.throwIfAborted();
            const request: SystemDocumentApproval = { id: crypto.randomUUID(), conversationId, documentId: id, name: document.name, path: document.path, before: document.content, after };
            const allowed = await new Promise<boolean>((resolve, reject) => {
                const cancel = () => { requests.delete(request.id); reject(signal.reason); };
                signal.addEventListener("abort", cancel, { once: true });
                requests.set(request.id, { request, resolve: allow => { signal.removeEventListener("abort", cancel); resolve(allow); } });
            });
            signal.throwIfAborted();
            if (!allowed)
                throw new Error("用户未授权本次内置文档写入；原内容保持不变");
            return gateway.write({ id, expectedRevision: document.revision, content: after, baseline: document.baseline });
        } };
}
export type MockSystemDocuments = ReturnType<typeof createMockSystemDocuments>;

/** Lazily bind mock document I/O; constructing a demo must not access native IPC. */
export function lazyMockSystemDocuments(storage: () => Storage): SystemDocumentGateway {
    let documents: ReturnType<typeof createMockSystemDocuments> | undefined;
    const gateway = () => (documents ??= createMockSystemDocuments(storage())).gateway;
    return {
        list: () => gateway().list(), read: id => gateway().read(id), write: input => gateway().write(input),
        pending: id => gateway().pending(id), decide: (conversation, request, allow) => gateway().decide(conversation, request, allow),
    };
}
