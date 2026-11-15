/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createExclusiveWritingGateway } from "./gateway/exclusiveWritingGateway";
import type { WritingGateway } from "./gateway/writingGateway";
import { useRequestedManuscript } from "./useRequestedManuscript";

function fixture() {
  const listManuscripts = vi.fn().mockResolvedValue([{id: "a"}, {id: "b"}]);
  const access = createExclusiveWritingGateway({listManuscripts} as unknown as WritingGateway);
  const saveCurrent = vi.fn().mockResolvedValue(true), onOpen = vi.fn(), onConsumed = vi.fn(), onError = vi.fn(), onFailure = vi.fn();
  const root = createRoot(document.createElement("div"));
  function Host({id, requestKey}: {id: string; requestKey: number}) {
    useRequestedManuscript({requestId: id, requestKey, access, saveCurrent, onOpen, onConsumed, onError, onFailure});
    return null;
  }
  return {access, listManuscripts, saveCurrent, onOpen, onConsumed, onError, onFailure,
    render: (id: string, requestKey = 0) => act(async () => root.render(<Host id={id} requestKey={requestKey}/>)),
    dispose: () => act(async () => root.unmount())};
}
it("keeps the latest external request pending until ownership releases, then saves before opening", async () => {
  const f = fixture(), release = await f.access.acquire();
  try {
    await f.render("a"); await f.render("b");
    expect(f.listManuscripts).not.toHaveBeenCalled(); expect(f.onConsumed).not.toHaveBeenCalled();
    await act(async () => release());
    expect(f.saveCurrent).toHaveBeenCalledTimes(1);
    expect(f.onOpen).toHaveBeenCalledExactlyOnceWith("b", [{id: "a"}, {id: "b"}]);
    expect(f.onConsumed).toHaveBeenCalledTimes(1);
  } finally {release(); await f.dispose();}
});
it("does not consume a request when saving fails", async () => {
  const f = fixture(); f.saveCurrent.mockResolvedValue(false);
  try {
    await f.render("a");
    expect(f.onOpen).not.toHaveBeenCalled(); expect(f.onConsumed).not.toHaveBeenCalled();
    expect(f.onFailure).toHaveBeenCalledOnce();
  } finally {await f.dispose();}
});
it("reports a missing manuscript and allows retrying the same id", async () => {
  const f = fixture(); f.listManuscripts.mockResolvedValueOnce([]);
  try {
    await f.render("a", 1);
    expect(f.onFailure).toHaveBeenCalledExactlyOnceWith("找不到引用的稿件");
    await f.render("a", 2);
    expect(f.onOpen).toHaveBeenCalledExactlyOnceWith("a", [{id: "a"}, {id: "b"}]);
  } finally {await f.dispose();}
});
it("ignores a late failure from an earlier request for the same manuscript", async () => {
  const f = fixture(); let reject!: (reason: Error) => void;
  f.listManuscripts.mockImplementationOnce(() => new Promise((_, fail) => {reject = fail;}));
  try {
    await f.render("a", 1); await f.render("a", 2);
    await act(async () => reject(new Error("late failure")));
    expect(f.onFailure).not.toHaveBeenCalled();
    expect(f.onOpen).toHaveBeenCalledExactlyOnceWith("a", [{id: "a"}, {id: "b"}]);
  } finally {await f.dispose();}
});
it("checks request ownership again before opening after an asynchronous read", async () => {
  let finish!: (value: Array<{id: string}>) => void;
  const access = createExclusiveWritingGateway({listManuscripts: () => new Promise(resolve => {finish = resolve;})} as unknown as WritingGateway);
  const saveCurrent = vi.fn().mockResolvedValue(true), onOpen = vi.fn(), onConsumed = vi.fn(), onError = vi.fn();
  let current = true;
  const root = createRoot(document.createElement("div"));
  function Host() {
    useRequestedManuscript({requestId: "a", requestKey: 1, access, saveCurrent, onOpen, onConsumed, onError, isCurrent: () => current});
    return null;
  }
  try {
    await act(async () => root.render(<Host/>));
    current = false;
    await act(async () => finish([{id: "a"}]));
    expect(saveCurrent).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onConsumed).not.toHaveBeenCalled();
  } finally {await act(async () => root.unmount());}
});
it("ignores a listing that arrives during ownership and reloads after release", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.listManuscripts.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  let release: (() => void) | undefined;
  try {
    await f.render("a");
    await act(async () => {release = await f.access.acquire();});
    await act(async () => finish([{id: "a"}]));
    expect(f.onOpen).not.toHaveBeenCalled();
    await act(async () => release?.());
    expect(f.listManuscripts).toHaveBeenCalledTimes(2); expect(f.onOpen).toHaveBeenCalledTimes(1);
  } finally {release?.(); await f.dispose();}
});
it("does not open an obsolete request after its save finishes", async () => {
  const f = fixture(); let finish!: (value: boolean) => void;
  f.saveCurrent.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  try {
    await f.render("a"); await f.render("b");
    await act(async () => finish(true));
    expect(f.onOpen).toHaveBeenCalledExactlyOnceWith("b", [{id: "a"}, {id: "b"}]);
  } finally {await f.dispose();}
});
