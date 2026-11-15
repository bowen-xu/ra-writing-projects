// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";
import { ManuscriptExplorer as ProductionManuscriptExplorer } from "./ManuscriptExplorer";
import {BuiltinPluginConfigurationTest} from "../../../../../../apps/web/src/app/builtinPluginConfiguration.testSupport";
import {selectAppStorage} from "../../../../../../apps/web/src/core/runtime/appStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ManuscriptExplorer(props: ComponentProps<typeof ProductionManuscriptExplorer>) {
  return <BuiltinPluginConfigurationTest owner="writing_projects"><ProductionManuscriptExplorer {...props}/></BuiltinPluginConfigurationTest>;
}

it("nests files, collapses directories, and creates files through an inline form", async () => {
  localStorage.clear();selectAppStorage(localStorage);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const props: ComponentProps<typeof ManuscriptExplorer> = {
    manuscriptId: "m",
    activePath: undefined, rootPath: undefined, directories: [], outline: [],
    files: [{ manuscriptId: "m", relativePath: parseManuscriptPath("sections/method.tex"), kind: "tex", sizeBytes: 0, sha256: "hash", modifiedAt: "2026-09-06" }],
    onSelectFile: vi.fn(), onCreateFile: vi.fn(), onRenameFile: vi.fn(), onDeleteFile: vi.fn(), onSetRoot: vi.fn(),
    onCreateDirectory: vi.fn(), onRenameDirectory: vi.fn(), onDeleteDirectory: vi.fn(), onSelectOutline: vi.fn(),
  };
  try {
    await act(async () => root.render(<ManuscriptExplorer {...props} />));
    let directory = host.querySelector<HTMLButtonElement>('button[aria-label="sections"]');
    expect(directory?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('button[aria-label="sections/method.tex"]')).not.toBeNull();
    expect(host.querySelector('.writing-outline-toggle')?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => host.querySelector<HTMLButtonElement>('.writing-outline-toggle')?.click());
    expect(localStorage.getItem("research-assistant:workspace.v1:writing-outline:m")).toBe("false");
    await act(async () => directory?.click());
    expect(host.querySelector('button[aria-label="sections/method.tex"]')).toBeNull();
    await act(async () => root.render(<ManuscriptExplorer {...props} key="restart" />));
    expect(host.querySelector('button[aria-label="sections/method.tex"]')).toBeNull();
    expect(host.querySelector('.writing-outline-toggle')?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => root.render(<ManuscriptExplorer {...props} key="restart" manuscriptId="other" />));
    expect(host.querySelector('button[aria-label="sections/method.tex"]')).not.toBeNull();
    expect(host.querySelector('.writing-outline-toggle')?.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("research-assistant:workspace.v1:writing-outline:other")).toBeNull();
    await act(async () => root.render(<ManuscriptExplorer {...props} key="restart" />));
    expect(host.querySelector('button[aria-label="sections/method.tex"]')).toBeNull();
    directory = host.querySelector<HTMLButtonElement>('button[aria-label="sections"]');
    await act(async () => directory?.click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="sections/method.tex"]')?.click());
    expect(props.onSelectFile).toHaveBeenCalledWith("sections/method.tex");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="新建文件"]')?.click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="工程相对路径"]');
    if (!input) throw new Error("Missing inline input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => { setter?.call(input, "results.tex"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onCreateFile).toHaveBeenCalledWith("sections/results.tex");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps the file explorer dedicated to files and outline", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const props: ComponentProps<typeof ManuscriptExplorer> = {
    activePath: undefined, rootPath: undefined, directories: [], outline: [], files: [],
    onSelectFile: vi.fn(), onCreateFile: vi.fn(), onRenameFile: vi.fn(), onDeleteFile: vi.fn(), onSetRoot: vi.fn(),
    onCreateDirectory: vi.fn(), onRenameDirectory: vi.fn(), onDeleteDirectory: vi.fn(), onSelectOutline: vi.fn(),
  };
  try {
    await act(async () => root.render(<ManuscriptExplorer {...props} />));
    expect(host.querySelector('[role="tablist"][aria-label="稿件资源类型"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="对话列表"]')).toBeNull();
    expect(host.querySelector('[aria-label="新建文件"]')).not.toBeNull();
    expect(host.querySelector('.writing-file-tree')).not.toBeNull();
    expect(host.querySelector('.writing-outline-toggle')).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("switches resource tabs and creates notes and note folders through the shared actions", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const props: ComponentProps<typeof ManuscriptExplorer> = {
    activePath: undefined, rootPath: undefined, directories: [], outline: [],
    files: [
      { manuscriptId: "m", relativePath: parseManuscriptPath("main.tex"), kind: "tex", sizeBytes: 0, sha256: "hash", modifiedAt: "2026-09-06" },
      { manuscriptId: "m", relativePath: parseManuscriptPath("notes/既有笔记.ranote"), kind: "other", sizeBytes: 0, sha256: "hash", modifiedAt: "2026-09-06" },
      { manuscriptId: "m", relativePath: parseManuscriptPath("notes/分组/已有.ranote"), kind: "other", sizeBytes: 0, sha256: "hash", modifiedAt: "2026-09-06" },
    ],
    onSelectFile: vi.fn(), onCreateFile: vi.fn(), onRenameFile: vi.fn(), onDeleteFile: vi.fn(), onSetRoot: vi.fn(),
    onCreateDirectory: vi.fn(), onRenameDirectory: vi.fn(), onDeleteDirectory: vi.fn(), onSelectOutline: vi.fn(),
  };
  async function fill(label: string, value: string) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  try {
    await act(async () => root.render(<ManuscriptExplorer {...props} />));
    await act(async () => host.querySelector<HTMLButtonElement>('#writing-explorer-tab-notes')!.click());
    expect(host.querySelector<HTMLDivElement>('#writing-explorer-panel-files')!.hidden).toBe(true);
    expect(host.querySelector<HTMLDivElement>('#writing-explorer-panel-notes')!.hidden).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建笔记"]')!.click());
    const section = host.querySelector('[aria-label="写作笔记"]')!;
    const folder = host.querySelector('button[aria-label="notes/分组"]')!;
    const slot = section.querySelector(".writing-create-slot")!;
    expect(folder.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await fill("笔记名称", "研究思路");
    await act(async () => host.querySelector<HTMLButtonElement>('#writing-explorer-tab-files')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('#writing-explorer-tab-notes')!.click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="笔记名称"]')!.value).toBe("研究思路");
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onCreateFile).toHaveBeenCalledWith("notes/研究思路.ranote");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建笔记文件夹"]')!.click());
    await fill("笔记文件夹名称", "实验");
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onCreateDirectory).toHaveBeenCalledWith("notes/实验");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="notes/分组"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建笔记"]')!.click());
    await fill("笔记名称", "分组笔记");
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onCreateFile).toHaveBeenCalledWith("notes/分组/分组笔记.ranote");
    expect(host.querySelector(".writing-note-root")).toBeNull();
    await act(async () => host.querySelector<HTMLElement>('[aria-label="写作笔记"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建笔记"]')!.click());
    await fill("笔记名称", "根目录笔记");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.onCreateFile).toHaveBeenCalledWith("notes/根目录笔记.ranote");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建笔记文件夹"]')!.click());
    const cancelSlot = host.querySelector<HTMLInputElement>('.writing-create-slot input')!;
    expect(cancelSlot).not.toBeNull();
    expect(cancelSlot.closest("form")!.querySelector("button")).toBeNull();
    await act(async () => cancelSlot.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".writing-create-slot")).toBeNull();
    expect(props.onCreateDirectory).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
