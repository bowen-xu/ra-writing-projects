// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWritingNote, parseManuscriptPath } from "@research-assistant/writing";
import { createBrowserWritingGateway } from "../gateway/browserWritingGateway";
import { selectAppStorage } from "../../../../../../apps/web/src/core/runtime/appStorage";
import { WritingNoteFloatingPanel, type WritingNoteWindowPort } from "./WritingNoteFloatingPanel";
vi.mock("./WritingNoteEditor", () => ({ default: (props: { content: string; onChange: (value: string) => void; readOnly?: boolean }) => <textarea aria-label="测试笔记正文" value={props.content} onChange={event => props.onChange(event.target.value)} readOnly={props.readOnly} /> }));
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); selectAppStorage(localStorage); });
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const original = createBrowserWritingGateway(), project = await original.createManuscript({ title: "test" });
  const path = parseManuscriptPath("notes/plan.ranote"), initial = JSON.stringify(createWritingNote("note-id", "block", "before"));
  const file = await original.createFile(project.id, path, initial);
  await original.saveSession({ manuscriptId: project.id, openPaths: [project.rootPath], activePath: project.rootPath, cursorState: { [project.rootPath]: 40 }, layoutState: { preview: true } });
  const gateway = { ...original, saveSession: vi.fn(original.saveSession), saveFile: vi.fn(original.saveFile) };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host), port = createRef<WritingNoteWindowPort>();
  const onClose = vi.fn(), onExpand = vi.fn(async () => true);
  await act(async () => root.render(<WritingNoteFloatingPanel target={{ manuscriptId: project.id, path, token: "token" }} gateway={gateway} windowRef={port} onClose={onClose} onExpand={onExpand} onFilesChanged={vi.fn()} />));
  const edit = async () => act(async () => {
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="测试笔记正文"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, JSON.stringify(createWritingNote("note-id", "block", "after")));
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { project, path, file, original, gateway, port, onClose, onExpand, edit, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
it("uses the existing CAS saver before expansion without overwriting manuscript layout/session state", async () => {
  const f = await setup();
  try {
    await f.edit();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="在笔记标签页中打开"]')!.click());
    expect(f.onExpand).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledOnce();
    expect((await f.original.readFile(f.project.id, f.path)).content).toContain("after");
    expect(f.gateway.saveSession).not.toHaveBeenCalled();
    expect((await f.original.getSession(f.project.id))?.activePath).toBe(f.project.rootPath);
  } finally { await f.dispose(); }
});
it("keeps a conflicting buffer open and uses the existing comparison instead of overwriting disk", async () => {
  const f = await setup();
  try {
    await f.edit();
    await f.original.saveFile({ manuscriptId: f.project.id, relativePath: f.path, content: JSON.stringify(createWritingNote("note-id", "block", "external")), expectedSha256: f.file.sha256 });
    await act(async () => { expect(await f.port.current!.prepareClose()).toBe(false); });
    expect(f.onClose).not.toHaveBeenCalled(); expect((await f.original.readFile(f.project.id, f.path)).content).toContain("external");
    expect(document.querySelector('[aria-label="解决稿件文件冲突"]')).not.toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="测试笔记正文"]')!.value).toContain("after");
  } finally { await f.dispose(); }
});
