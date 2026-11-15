/** @vitest-environment happy-dom */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect,it,vi } from "vitest";
import { useWritingPersistence, type WritingPersistenceControl, type WritingSavePause } from "./useWritingPersistence";
import type { WritingGateway } from "./gateway/writingGateway";
import type { SaveState } from "./workspaceState";

it("nested pause leases block manual and automatic saves until the last idempotent release",async()=>{
  vi.useFakeTimers();
  const container=document.createElement("div"),root=createRoot(container);
  const saveFile=vi.fn().mockResolvedValue({sha256:"next"});
  const gateway={saveFile,clearRecoveryDraft:vi.fn().mockResolvedValue(undefined),listFiles:vi.fn().mockResolvedValue([]),saveRecoveryDraft:vi.fn().mockResolvedValue(undefined),saveSession:vi.fn().mockResolvedValue(undefined)} as unknown as WritingGateway;
  let control!:WritingPersistenceControl;
  function Host() {
    const [saveState,setSaveState]=useState<SaveState>("dirty"),[contentHash,setContentHash]=useState<string|undefined>("base");
    control=useWritingPersistence({activeManuscriptId:"m",activePath:"main.tex",content:"draft",contentHash,saveState,setSaveState,setContentHash,gateway,
      cursorOffsets:{},openPaths:["main.tex"],layoutState:{},onFileConflict:vi.fn(),setError:vi.fn(),setFiles:vi.fn()});
    return null;
  }
  try {
    await act(async()=>root.render(<Host/>));
    let releaseOne!:()=>void,releaseTwo!:()=>void;
    await act(async()=>{releaseOne=await control.pause();releaseTwo=await control.pause();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500);expect(await control()).toBe(false);});
    expect(saveFile).not.toHaveBeenCalled();
    await act(async()=>{releaseOne();releaseOne();});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
    expect(saveFile).not.toHaveBeenCalled();
    await act(async()=>releaseTwo());
    await act(async()=>{await vi.advanceTimersByTimeAsync(701);});
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith(expect.objectContaining({content:"draft",expectedSha256:"base"}));
  } finally {await act(async()=>root.unmount());vi.useRealTimers();}
});

it("observes the settled disk version with newer dirty text before React commits the save result", async () => {
  const root = createRoot(document.createElement("div"));
  let control!: WritingPersistenceControl;
  let finish!: (value: {sha256: string}) => void;
  const saveFile = vi.fn(() => new Promise<{sha256: string}>(resolve => { finish = resolve; }));
  const gateway = {saveFile, clearRecoveryDraft: vi.fn().mockResolvedValue(undefined),
    listFiles: vi.fn().mockResolvedValue([]), saveRecoveryDraft: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(undefined)} as unknown as WritingGateway;
  function Host({text}: {text: string}) {
    const [saveState, setSaveState] = useState<SaveState>("dirty");
    const [contentHash, setContentHash] = useState<string | undefined>("base");
    control = useWritingPersistence({activeManuscriptId: "m", activePath: "main.tex", content: text,
      contentHash, saveState, setSaveState, setContentHash, gateway, cursorOffsets: {},
      openPaths: ["main.tex"], layoutState: {}, onFileConflict: vi.fn(), setError: vi.fn(), setFiles: vi.fn()});
    return null;
  }
  let lease: WritingSavePause | undefined;
  try {
    await act(async () => root.render(<Host text="first"/>));
    let saving!: Promise<boolean>;
    await act(async () => { saving = control(); });
    await act(async () => root.render(<Host text="later input"/>));
    await act(async () => {
      const paused = control.pause();
      finish({sha256: "saved-first"});
      lease = await paused;
      expect(await saving).toBe(false);
      expect(lease.readSnapshot()).toEqual({manuscriptId: "m", relativePath: "main.tex",
        content: "later input", contentHash: "saved-first", saveState: "dirty"});
      const copy = lease.readSnapshot();
      Object.assign(copy!, {contentHash: "tampered"});
      expect(lease.readSnapshot()?.contentHash).toBe("saved-first");
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
    await act(async () => lease?.());
    expect(lease?.readSnapshot()).toBeUndefined();
  } finally {
    await act(async () => { lease?.(); root.unmount(); });
  }
});

it("does not grant the pause until an existing native save settles",async()=>{
  vi.useFakeTimers();
  const root=createRoot(document.createElement("div"));
  let finish!:(value:{sha256:string})=>void,control!:WritingPersistenceControl,acquired=false;
  const saveFile=vi.fn(()=>new Promise<{sha256:string}>(resolve=>{finish=resolve;}));
  const gateway={saveFile,clearRecoveryDraft:vi.fn().mockResolvedValue(undefined),listFiles:vi.fn().mockResolvedValue([]),saveRecoveryDraft:vi.fn().mockResolvedValue(undefined),saveSession:vi.fn().mockResolvedValue(undefined)} as unknown as WritingGateway;
  function Host() {
    const [saveState,setSaveState]=useState<SaveState>("dirty"),[contentHash,setContentHash]=useState<string|undefined>("base");
    control=useWritingPersistence({activeManuscriptId:"m",activePath:"main.tex",content:"draft",contentHash,saveState,setSaveState,setContentHash,gateway,
      cursorOffsets:{},openPaths:["main.tex"],layoutState:{},onFileConflict:vi.fn(),setError:vi.fn(),setFiles:vi.fn()});
    return null;
  }
  try {
    await act(async()=>root.render(<Host/>));
    let pending!:Promise<boolean>,paused!:Promise<()=>void>;
    await act(async()=>{pending=control();paused=control.pause().then(release=>{acquired=true;return release;});});
    expect(acquired).toBe(false);expect(saveFile).toHaveBeenCalledTimes(1);
    await act(async()=>{finish({sha256:"next"});await pending;});
    expect(acquired).toBe(true);
    const release=await paused;
    expect(await control()).toBe(false);
    await act(async()=>release());
    expect(await control()).toBe(true);expect(saveFile).toHaveBeenCalledTimes(1);
  } finally {await act(async()=>root.unmount());vi.useRealTimers();}
});
