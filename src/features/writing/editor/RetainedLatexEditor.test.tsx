// @vitest-environment happy-dom
import {act, type ComponentProps} from "react";
import {createRoot} from "react-dom/client";
import {EditorView} from "@codemirror/view";
import {undo} from "@codemirror/commands";
import {getOriginalDoc} from "@codemirror/merge";
import {expect, it, vi} from "vitest";
import {LatexEditor} from "./LatexEditor";
import {RetainedLatexEditor} from "./RetainedLatexEditor";
import {WritingFileSessions} from "./writingFileSessions";

it("retains the actual view through note/loading surfaces without sending hidden edits into another document", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  const files = new WritingFileSessions(), session = files.open({manuscriptId: "m", relativePath: "main.tex"}, "before", "a".repeat(64));
  const onChange = vi.fn(), onReady = vi.fn();
  const props: ComponentProps<typeof LatexEditor> = {documentKey: "m:main.tex", value: "before", fileSession: session,
    onChange, onReady, onCompile: vi.fn(), onOpenCommands: vi.fn(), onCursorChange: vi.fn(), diagnostics: [], focusRequest: undefined,
    completionData: {citationKeys: [], labels: [], files: []}, codeCheckEnabled: false, onCodeCheckResult: vi.fn()};
  try {
    await act(async () => root.render(<RetainedLatexEditor visible source={<LatexEditor {...props}/>}/>));
    const element = host.querySelector<HTMLElement>(".cm-editor")!, view = EditorView.findFromDOM(element)!;
    const destroy = vi.spyOn(view, "destroy");
    await act(async () => view.dispatch({selection: {anchor: 3}}));
    for(let visit = 0; visit < 5; visit++) {
      await act(async () => root.render(<RetainedLatexEditor visible source={undefined}/>));
      expect(host.querySelector(".cm-editor")).toBe(element); expect(onReady).toHaveBeenLastCalledWith(null);
      expect(host.querySelector<HTMLElement>(".writing-retained-source")!.hidden).toBe(true);
      await act(async () => root.render(<RetainedLatexEditor visible source={<LatexEditor {...props}/>}/>));
      expect(EditorView.findFromDOM(element)).toBe(view); expect(view.state.selection.main.head).toBe(3);
    }
    await act(async () => root.render(<RetainedLatexEditor visible source={undefined}/>)); onChange.mockClear();
    const port = session.applicationPort;
    await act(async () => expect(port.apply({operationId: "hidden-source", expected: port.read()!, text: "after"}).status).toBe("applied"));
    const receipt = port.readReceipt("hidden-source");
    expect(session.read().content).toBe("after"); expect(onChange).not.toHaveBeenCalled();
    await act(async () => root.render(<RetainedLatexEditor visible source={<LatexEditor {...props} value="after"/>}/>));
    expect(EditorView.findFromDOM(element)).toBe(view); expect(getOriginalDoc(view.state).toString()).toBe("before");
    await act(async () => {expect(undo(view)).toBe(true);});
    expect(session.read().content).toBe("before"); expect(port.readReceipt("hidden-source")).toEqual(receipt);
    expect(destroy).not.toHaveBeenCalled();
    await act(async () => root.render(null)); expect(destroy).toHaveBeenCalledOnce();
  } finally {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();}
});
