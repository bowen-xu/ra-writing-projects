// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useWritingPersistence, type WritingPersistenceControl } from "./useWritingPersistence";
import type { WritingGateway } from "./gateway";
import type { SaveState } from "./workspaceState";

it("restarts the fallback/Writing Note save deadline on each edit and still supports explicit flush", async () => {
  vi.useFakeTimers();
  const saveFile = vi.fn(async () => ({ sha256: "next" }));
  const saveRecoveryDraft = vi.fn(async () => undefined);
  const gateway = { saveFile, saveRecoveryDraft, clearRecoveryDraft: vi.fn(async () => undefined),
    saveSession: vi.fn(async () => undefined), listFiles: vi.fn(async () => []) } as unknown as WritingGateway;
  let change!: (text: string) => void, control!: WritingPersistenceControl;
  function Host() {
    const [content, setContent] = useState("initial"), [saveState, setSaveState] = useState<SaveState>("saved");
    const [contentHash, setContentHash] = useState<string | undefined>("base");
    change = text => { setContent(text); setSaveState("dirty"); };
    control = useWritingPersistence({ activeManuscriptId: "m", activePath: "note.ranote", content, contentHash, saveState,
      setSaveState, setContentHash, gateway, cursorOffsets: {}, openPaths: ["note.ranote"], layoutState: {},
      onFileConflict: vi.fn(), setError: vi.fn(), setFiles: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Host />));
    for (let index = 0; index < 5; index++) {
      await act(async () => change(`edit ${index}`));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    }
    expect(saveFile).not.toHaveBeenCalled(); expect(saveRecoveryDraft).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(saveFile).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(saveFile).toHaveBeenCalledOnce();
    expect(saveFile).toHaveBeenCalledWith(expect.objectContaining({ content: "edit 4" }));
    await act(async () => change("switch now"));
    await act(async () => { expect(await control()).toBe(true); });
    expect(saveFile).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(saveFile).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
