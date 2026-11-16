/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { WritingEditorPane } from "@research-assistant/writing-projects-preview/writing-editor-pane";
import { WritingFileSessions } from "@research-assistant/writing-projects-preview/writing-file-sessions";
import { readEditorPreferences } from "@research-assistant/writing-projects-preview/editor-preferences";
import { WorkspaceTabsProvider } from "@research-assistant/workbench-preview/workbench-c5927e";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("registers the file-owned port and preserves its native receipt through visible tab switches", async () => {
  const files = new WritingFileSessions(), host = document.createElement("div"), tabHost = document.createElement("div"), root = createRoot(host);
  document.body.append(host, tabHost);
  const first = files.open({ manuscriptId: "manuscript", relativePath: "main.tex" }, "before", "a".repeat(64));
  files.open({ manuscriptId: "manuscript", relativePath: "second.tex" }, "second", "b".repeat(64));
  const ready = vi.fn(), change = vi.fn();
  const props: ComponentProps<typeof WritingEditorPane> = {
    activeManuscriptId: "manuscript", activePath: "main.tex", content: "before", fileSessions: files, tabHost,
    completionData: { citationKeys: [], files: [], labels: [] }, cursorOffset: 0, diagnostics: [],
    focusRequest: undefined, insertionRequest: undefined, openPaths: ["main.tex", "second.tex"], saveState: "dirty",
    onChange: change, onClose: vi.fn(), onCompile: vi.fn(), onOpenCommands: vi.fn(), onCursorChange: vi.fn(), onSelect: vi.fn(),
    preferences: readEditorPreferences(null), onInsertCitation: vi.fn(), codeCheckEnabled: false,
    hasCodeCheckErrors: false, onCodeCheckResult: vi.fn(), onEditorSessionReady: ready,
    syncActions: { forward: vi.fn(), backward: vi.fn(), forwardDisabled: undefined, backwardDisabled: undefined },
  };
  try {
    await act(async () => root.render(<WritingEditorPane {...props} />));
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!);
    const tabs = tabHost.querySelector<HTMLElement>(".editor-tabs");
    expect(tabs).not.toBeNull();
    expect(host.querySelector(".editor-tabs")).toBeNull();
    await act(async () => root.render(<WritingEditorPane {...props} tabsActive={false} />));
    expect(tabs?.hidden).toBe(true);
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
    await act(async () => root.render(<WritingEditorPane {...props} tabsActive />));
    expect(tabHost.querySelector(".editor-tabs")).toBe(tabs);
    expect(tabs?.hidden).toBe(false);
    await act(async () => {
      tabHost.querySelector<HTMLButtonElement>('[aria-label="second.tex"]')?.click();
      tabHost.querySelector<HTMLButtonElement>('[aria-label="关闭 second.tex"]')?.click();
    });
    expect(props.onSelect).toHaveBeenCalledWith("second.tex");
    expect(props.onClose).toHaveBeenCalledWith("second.tex");
    expect(ready).toHaveBeenLastCalledWith(first.applicationPort);
    const port = first.applicationPort;
    await act(async () => expect(port.apply({ operationId: "agent", expected: port.read()!, text: "after" }).status).toBe("applied"));
    expect(change).toHaveBeenLastCalledWith("after");
    const receipt = port.readReceipt("agent");
    await act(async () => root.render(<WritingEditorPane {...props} activePath="second.tex" content="second" />));
    expect(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
    expect(port.read()?.text).toBe("after");
    expect(port.readReceipt("agent")).toEqual(receipt);
    await act(async () => root.render(<WritingEditorPane {...props} content="after" />));
    expect(ready).toHaveBeenLastCalledWith(port);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.click());
    expect(first.read()).toMatchObject({ content: "before", reviewBaseline: "before" });
    expect(port.readReceipt("agent")).toEqual(receipt);
    // A manuscript selection changes before its loader has delivered the new text.
    await act(async () => root.render(<WritingEditorPane {...props} activeManuscriptId="new-manuscript" />));
    const newIdentity = { manuscriptId: "new-manuscript", relativePath: "main.tex" };
    expect(files.get(newIdentity)).toBeUndefined();
    expect(first.read().content).toBe("before");
    await act(async () => {
      files.open(newIdentity, "new manuscript", "c".repeat(64));
      root.render(<WritingEditorPane {...props} activeManuscriptId="new-manuscript" content="new manuscript" />);
    });
    expect(files.get(newIdentity)?.read().content).toBe("new manuscript");
    expect(host.querySelector(".cm-content")?.textContent).toBe("new manuscript");
  } finally { await act(async () => root.unmount()); host.remove(); tabHost.remove(); }
});

it("disables citation insertion only when its host declares the citation port unavailable", async () => {
  const host = document.createElement("div"), root = createRoot(host), insert = vi.fn(); document.body.append(host);
  const props: ComponentProps<typeof WritingEditorPane> = {
    activeManuscriptId: "manuscript", activePath: "main.tex", content: "source", openPaths: ["main.tex"], saveState: "saved",
    completionData: {citationKeys: [], files: [], labels: []}, cursorOffset: 0, diagnostics: [], focusRequest: undefined, insertionRequest: undefined,
    onChange: vi.fn(), onClose: vi.fn(), onCompile: vi.fn(), onOpenCommands: vi.fn(), onCursorChange: vi.fn(), onSelect: vi.fn(),
    preferences: readEditorPreferences(null), onInsertCitation: insert, codeCheckEnabled: false, hasCodeCheckErrors: false, onCodeCheckResult: vi.fn(),
    syncActions: {forward: vi.fn(), backward: vi.fn(), forwardDisabled: undefined, backwardDisabled: undefined},
  };
  try {
    await act(async () => root.render(<WritingEditorPane {...props}/>));
    const button = host.querySelector<HTMLButtonElement>('[aria-label="插入引用"]')!, editor = host.querySelector(".cm-editor");
    expect(button.disabled).toBe(false); await act(async () => button.click()); expect(insert).toHaveBeenCalledTimes(1);
    const reason = "当前宿主未接入受管引用端口。";
    await act(async () => root.render(<WritingEditorPane {...props} citationDisabledReason={reason}/>));
    expect(button.disabled).toBe(true); expect(button.getAttribute("aria-description")).toBe(reason); expect(button.hasAttribute("title")).toBe(false);
    await act(async () => button.click()); expect(insert).toHaveBeenCalledTimes(1); expect(host.querySelector(".cm-editor")).toBe(editor);
    await act(async () => root.render(<WritingEditorPane {...props}/>));
    expect(button.disabled).toBe(false); expect(button.hasAttribute("title")).toBe(false);
  } finally {await act(async () => root.unmount()); host.remove();}
});

it.each(["inline", "shared", "managed"] as const)("allocates the source rows for the real %s tab owner without recreating the editor", async mode => {
  const host = document.createElement("div"), root = createRoot(host), files = new WritingFileSessions(); document.body.append(host);
  const file = files.open({manuscriptId: "manuscript", relativePath: "main.tex"}, "source", "a".repeat(64));
  const props: ComponentProps<typeof WritingEditorPane> = {
    activeManuscriptId: "manuscript", activePath: "main.tex", content: "source", openPaths: ["main.tex"], saveState: "saved", fileSessions: files,
    managedTabs: mode === "managed", completionData: {citationKeys: [], files: [], labels: []}, cursorOffset: 0, diagnostics: [], focusRequest: undefined, insertionRequest: undefined,
    onChange: vi.fn(), onClose: vi.fn(), onCompile: vi.fn(), onOpenCommands: vi.fn(), onCursorChange: vi.fn(), onSelect: vi.fn(),
    preferences: readEditorPreferences(null), onInsertCitation: vi.fn(), codeCheckEnabled: false, hasCodeCheckErrors: false, onCodeCheckResult: vi.fn(),
    syncActions: {forward: vi.fn(), backward: vi.fn(), forwardDisabled: undefined, backwardDisabled: undefined},
  };
  const render = async (tabsActive: boolean) => {const pane = <WritingEditorPane {...props} tabsActive={tabsActive}/>;
    await act(async () => root.render(mode === "shared" ? <WorkspaceTabsProvider>{pane}</WorkspaceTabsProvider> : pane));};
  try {
    await render(true);
    const column = host.querySelector<HTMLElement>(".writing-editor-column")!, editor = host.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor), port = file.applicationPort;
    expect(column.dataset.tabsDocked).toBe(String(mode !== "inline"));
    expect(column.dataset.inlineTabs).toBe(String(mode === "inline"));
    expect(column.querySelector(".editor-tabs") !== null).toBe(mode === "inline");
    expect([...column.children].map(child => child.className)).toEqual([
      ...(mode === "inline" ? ["editor-tabs"] : []), "writing-editor-tools", "writing-editor-host", "writing-editor-status",
    ]);
    await render(false); await render(true);
    expect(host.querySelector(".writing-editor-column")).toBe(column); expect(EditorView.findFromDOM(editor)).toBe(view);
    expect(view?.state).toBe(file.state); expect(file.applicationPort).toBe(port);
  } finally {await act(async () => root.unmount()); host.remove();}
});
