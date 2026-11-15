/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useWritingWorkbenchVisibility } from "./useWritingWorkbenchVisibility";

it("keeps shell ownership across source, note and loading states and releases it only on Home or unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div")), report = vi.fn();
  function Workbench({home, path}: {home: boolean; path?: string | undefined}) {
    useWritingWorkbenchVisibility(home, report);
    return <span>{path ?? "loading"}</span>;
  }
  try {
    await act(async () => root.render(<Workbench home path="main.tex"/>));
    await act(async () => root.render(<Workbench home={false} path="main.tex"/>));
    expect(report.mock.calls).toEqual([[false], [true]]);
    report.mockClear();
    for (const path of ["notes/outline.ranote", undefined, "sections/introduction.tex", "main.tex"]) {
      await act(async () => root.render(<Workbench home={false} path={path}/>));
    }
    expect(report).not.toHaveBeenCalled();
    await act(async () => root.render(<Workbench home/>));
    expect(report.mock.calls).toEqual([[false]]);
    await act(async () => root.render(<Workbench home={false} path="main.tex"/>));
    await act(async () => root.unmount());
    expect(report.mock.calls).toEqual([[false], [true], [false]]);
  } finally { vi.unstubAllGlobals(); }
});
