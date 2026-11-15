import { describe, expect, it, vi } from "vitest";

import { flushLatestSave } from "./useWritingPersistence";
import type { SaveState } from "./workspaceState";

describe("flushLatestSave", () => {
  it("does not mark a newer baseline-only version saved after an older write", async () => {
    let snapshot = { manuscriptId: "m", relativePath: "main.tex", content: "same body", contentHash: "hash", saveState: "dirty" as SaveState, version: 1 };
    let finish!: (value: { sha256: string }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise<{ sha256: string }>((resolve) => { finish = resolve; }))
      .mockResolvedValue({ sha256: "hash" });
    const saved = vi.fn();
    const operation = flushLatestSave({ getSnapshot: () => snapshot, persist, onFailure: vi.fn(), onSaving: vi.fn(),
      onSaved: saved, onSuperseded: vi.fn() });
    snapshot = { ...snapshot, version: 2 };
    finish({ sha256: "hash" });
    expect(await operation).toBe(true);
    expect(persist.mock.calls.map(([value]) => value.version)).toEqual([1, 2]);
    expect(saved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 2 }), "hash");
  });
  it("finishes an in-flight write but stops before persisting newer input while paused", async () => {
    let snapshot = {manuscriptId:"m",relativePath:"main.tex",content:"before",contentHash:"hash-0",saveState:"dirty" as SaveState};
    let paused=false, finish!:(value:{sha256:string})=>void;
    const persist=vi.fn().mockImplementationOnce(()=>new Promise<{sha256:string}>(resolve=>{finish=resolve;})).mockResolvedValue({sha256:"hash-2"});
    const options={canPersist:()=>!paused,getSnapshot:()=>snapshot,persist,onFailure:vi.fn(),onSaving:vi.fn(),
      onSaved:(_saved:unknown,hash:string)=>{snapshot={...snapshot,contentHash:hash,saveState:"saved"};},
      onSuperseded:(_saved:unknown,hash:string)=>{snapshot={...snapshot,contentHash:hash,saveState:"dirty"};}};
    const pending=flushLatestSave(options);
    snapshot={...snapshot,content:"later input"};paused=true;finish({sha256:"hash-1"});
    expect(await pending).toBe(false);
    expect(snapshot).toMatchObject({content:"later input",contentHash:"hash-1",saveState:"dirty"});
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await flushLatestSave(options)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    paused=false;expect(await flushLatestSave(options)).toBe(true);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({content:"later input",contentHash:"hash-1"});
  });
  it("serializes an in-flight save and persists the newest buffer before resolving", async () => {
    let snapshot: {
      manuscriptId: string;
      relativePath: string;
      content: string;
      contentHash: string;
      saveState: SaveState;
    } = {
      manuscriptId: "manuscript",
      relativePath: "main.tex",
      content: "first version",
      contentHash: "hash-0",
      saveState: "dirty",
    };
    let releaseFirst: ((value: { readonly sha256: string }) => void) | undefined;
    const firstSave = new Promise<{ readonly sha256: string }>((resolve) => { releaseFirst = resolve; });
    const persist = vi.fn()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValueOnce({ sha256: "hash-2" });
    const states: string[] = [];

    const operation = flushLatestSave({
      getSnapshot: () => snapshot,
      onFailure: vi.fn(),
      onSaved: (_saved, sha256) => {
        snapshot = { ...snapshot, contentHash: sha256, saveState: "saved" };
        states.push("saved");
      },
      onSaving: () => { states.push("saving"); },
      onSuperseded: (_saved, sha256) => {
        snapshot = { ...snapshot, contentHash: sha256, saveState: "dirty" };
        states.push("dirty");
      },
      persist,
    });
    snapshot = { ...snapshot, content: "latest version", saveState: "dirty" };
    releaseFirst?.({ sha256: "hash-1" });

    await expect(operation).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      content: "latest version",
      contentHash: "hash-1",
    });
    expect(states).toEqual(["saving", "dirty", "saving", "saved"]);
  });
});
