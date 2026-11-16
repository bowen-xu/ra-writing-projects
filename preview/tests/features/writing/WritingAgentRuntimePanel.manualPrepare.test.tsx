/** @vitest-environment happy-dom */
import {act, useMemo} from "react";
import {createRoot} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {WorkspaceTabsProvider} from "@research-assistant/workbench-preview/workbench-c5927e";
import {selectAppStorage} from "@research-assistant/workbench-preview/app-storage";
import {registerStoragePersistence} from "@research-assistant/workbench-preview/storage-persistence";
import {AgentDraftProvider} from "@research-assistant/workbench-preview/agent-draft-provider";
import {WritingDiffDemoStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-storage";
import {WritingDiffDemoAgentStorage} from "@research-assistant/writing-projects-preview/writing-diff-demo-agent-storage";
import {createWritingDiffDemoRuntime} from "@research-assistant/writing-projects-preview/writing-diff-demo-runtime";
import {projectConversationMessages} from "@research-assistant/workbench-preview/project-conversation-messages";
import {useAgentConversation} from "@research-assistant/workbench-preview/use-agent-conversation";
import {resetWritingSubmissionControllersForTests} from "@research-assistant/workbench-preview/writing-submission-controller";
import {resetWritingCompactionOwnersForTests} from "@research-assistant/writing-projects-preview/writing-compaction-controller";
import {WritingAgentRuntimePanel} from "@research-assistant/writing-projects-preview/writing-agent-runtime-panel";
import {SpeechInputAdapterProvider} from "@research-assistant/workbench-preview/speech-input-adapter";
import {writingDemoSpeechAdapter} from "@research-assistant/workbench-preview/writing-demo-speech-adapter";
import {parseManuscriptPath} from "@research-assistant/writing";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); resetWritingCompactionOwnersForTests(); resetWritingSubmissionControllersForTests(); vi.restoreAllMocks();});
async function fixture() {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn(async (_value: string) => undefined);
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});
  cleanup.push(() => {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  const rows = new Map<string, string>(), storage: Storage = {get length() {return rows.size;}, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => {rows.set(key, value);}, removeItem: key => {rows.delete(key);}, clear: () => rows.clear()}; selectAppStorage(storage);
  const scope = {manuscriptId: crypto.randomUUID(), conversationId: crypto.randomUUID()}, files = new WritingDiffDemoStorage(scope.manuscriptId,
    [{path: "main.tex", before: "original disk", after: "original disk", kind: "modified", additions: 0, deletions: 0}]), agent = new WritingDiffDemoAgentStorage(files, undefined),
    runtime = createWritingDiffDemoRuntime(files, agent, scope.manuscriptId, scope.conversationId); runtime.setCompactionDuration(0); cleanup.push(() => runtime.dispose());
  const disk = await files.files.readFile(scope.manuscriptId, "main.tex"), editor = {documentKey: `${scope.manuscriptId}:main.tex`, sessionId: crypto.randomUUID(), revision: crypto.randomUUID(), text: "original unsaved"};
  const prepare = vi.spyOn(runtime.compaction.gateway, "prepareWriting"), status = vi.spyOn(runtime.compaction.gateway, "prepareWritingStatus"), start = vi.spyOn(runtime.compaction.gateway, "start");
  let root: ReturnType<typeof createRoot> | null = null; const host = document.createElement("div"); document.body.append(host);
  function Harness() {
    const history = useAgentConversation(scope.conversationId, undefined, runtime.history), messages = useMemo(() => projectConversationMessages(history.projection), [history.projection]);
    return <WritingAgentRuntimePanel gateways={runtime.gateways} {...scope} conversationTitle="手动压缩恢复" activePath="main.tex" content={editor.text} contentHash={disk.sha256}
      readEditorSnapshot={() => editor} files={[{manuscriptId: scope.manuscriptId, relativePath: parseManuscriptPath("main.tex"), kind: "tex", sha256: disk.sha256, sizeBytes: 13, modifiedAt: "now"}]}
      messages={messages} projection={history.projection} historyReady={history.status === "ready"} open onOpenChange={() => {}}/>;
  }
  const mount = async () => {root = createRoot(host); await act(async () => root!.render(<WorkspaceTabsProvider><SpeechInputAdapterProvider adapter={writingDemoSpeechAdapter}><AgentDraftProvider><Harness/></AgentDraftProvider></SpeechInputAdapterProvider></WorkspaceTabsProvider>));};
  const unmount = async () => {if (root) {await act(async () => root!.unmount()); root = null;}}; cleanup.push(async () => {await unmount(); host.remove();});
  const button = (label: string) => [...host.querySelectorAll("button")].find(button => button.textContent === label);
  const send = async () => {
    const input = host.querySelector("textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "/compact"); input.dispatchEvent(new Event("input", {bubbles: true}));});
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  };
  const diagnostic = async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="复制诊断信息"]')!.click());
    return writeText.mock.lastCall?.[0] ?? "";
  };
  return {scope, rows, storage, files, runtime, editor, prepare, status, start, host, mount, unmount, button, send, diagnostic};
}
it("reopens a real manual prepare ACK loss read-only and confirms the same R/W without preparing current materials again", async () => {
  const f = await fixture(), modelIO = vi.spyOn(f.runtime.gateways.commands!, "compact"); f.runtime.compaction.failNext("prepare", "afterCommit"); await f.mount(); await f.send();
  await vi.waitFor(() => expect(f.button("核对原准备")).toBeDefined());
  expect(f.host.textContent).toContain("操作结果尚未确认");
  const diagnostic = await f.diagnostic();
  expect(diagnostic).toContain("COMPACTION_RESULT_UNCONFIRMED");
  expect(diagnostic).not.toContain("original unsaved");
  const original = f.prepare.mock.calls[0]![0]; expect(original.request.context.files[0]?.buffer?.text).toBe("original unsaved"); expect(f.start).not.toHaveBeenCalled();
  const locator = [...f.rows.entries()].find(([key]) => key.includes("writing-compaction-receipt"))!; expect(JSON.parse(locator[1]).manual.prepare).toEqual(original);
  await f.unmount(); resetWritingCompactionOwnersForTests(); resetWritingSubmissionControllersForTests(); f.editor.text = "later editor text";
  const readFile = vi.spyOn(f.files.files, "readFile"); await f.mount();
  await vi.waitFor(() => expect(f.button("确认并继续原压缩请求")).toBeDefined());
  expect(f.status).toHaveBeenCalledExactlyOnceWith(original); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
  await act(async () => f.button("确认并继续原压缩请求")!.click());
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  expect(f.start.mock.calls[0]![0]).toMatchObject({requestId: original.request.requestId, expectedRevision: original.expectedRevision});
  await vi.waitFor(() => expect([...f.rows.keys()].some(key => key.includes("writing-compaction-receipt"))).toBe(false));
  expect(f.prepare).toHaveBeenCalledOnce(); const events = (await f.runtime.history.gateway.readHistory({conversationId: f.scope.conversationId, afterSeq: 0, limit: 200})).events;
  expect(events.filter(event => event.payload.type === "turnStarted")).toHaveLength(1); expect(modelIO).toHaveBeenCalledOnce();
  expect(events.filter(event => event.payload.type === "itemStarted" && event.payload.kind.type === "userMessage")).toHaveLength(0);
});
it("a committed local save failure offers local-only recovery before a separate explicit confirmation", async () => {
  const f = await fixture(); let fail = true;
  registerStoragePersistence(f.storage, {backend: "IndexedDB", pending: false, error: undefined, resetting: false, flush: async () => {
    if (fail && [...f.rows.entries()].some(([key, value]) => key.includes("writing-compaction-receipt") && JSON.parse(value).manual?.result)) throw new Error("local ACK save failed");
  }, retry: async () => {}, reset: async () => {}, subscribe: () => () => {}, close: () => {}});
  await f.mount(); await f.send(); await vi.waitFor(() => expect(f.button("重试本机收尾")).toBeDefined()); expect(f.start).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled();
  fail = false; await act(async () => f.button("重试本机收尾")!.click());
  await vi.waitFor(() => expect(f.button("确认并继续原压缩请求")).toBeDefined()); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.status).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  await act(async () => f.button("确认并继续原压缩请求")!.click()); await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce()); expect(f.prepare).toHaveBeenCalledOnce();
});
