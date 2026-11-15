// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExplorerCreateSlot } from "./ExplorerCreateSlot";

it.each(["file", "note", "directory"] as const)("cancels %s creation on blur without submitting", async kind => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), cancel = vi.fn(), submit = vi.fn();
  try {
    await act(async () => root.render(<ExplorerCreateSlot kind={kind} label="名称" value="draft" depth={0} onChange={() => {}} onSubmit={submit} onCancel={cancel} />));
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => input.blur());
    expect(cancel).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
