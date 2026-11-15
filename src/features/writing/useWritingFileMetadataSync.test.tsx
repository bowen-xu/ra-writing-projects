/** @vitest-environment happy-dom */
import {act, StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import type {WritingGateway} from "./gateway";
import {useWritingFileMetadataSync} from "./useWritingFileMetadataSync";

it("checks only metadata on window return, coalesces focus signals, and ignores responses after unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolve!: (files: never[]) => void;
  const listFiles = vi.fn(() => new Promise<never[]>(done => {resolve = done;})), readFile = vi.fn(), onFiles = vi.fn();
  const root = createRoot(document.createElement("div"));
  const props = {manuscriptId: "m", gateway: {listFiles, readFile} as unknown as WritingGateway, canRead: () => true, onFiles, onError: vi.fn()};
  try {
    await act(async () => root.render(<StrictMode><Host/></StrictMode>));
    function Host() {useWritingFileMetadataSync(props); return null;}
    expect(listFiles).not.toHaveBeenCalled();
    await act(async () => {window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"));});
    expect(listFiles).toHaveBeenCalledExactlyOnceWith("m"); expect(readFile).not.toHaveBeenCalled();
    await act(async () => {resolve([]);}); expect(onFiles).toHaveBeenCalledExactlyOnceWith([]);
    await act(async () => {window.dispatchEvent(new Event("focus"));});
    await act(async () => root.unmount());
    await act(async () => {resolve([]); window.dispatchEvent(new Event("focus"));});
    expect(onFiles).toHaveBeenCalledOnce(); expect(listFiles).toHaveBeenCalledTimes(2);
  } finally {vi.unstubAllGlobals();}
});
