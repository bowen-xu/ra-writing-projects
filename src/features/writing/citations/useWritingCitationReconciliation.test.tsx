/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {parseManuscriptPath, type ManuscriptFile} from "@research-assistant/writing";
import {WritingFileSessions} from "../editor/writingFileSessions";
import {useWritingCitationReconciliation} from "./useWritingCitationReconciliation";

type Options = Parameters<typeof useWritingCitationReconciliation>[0];
function harness() {
  const root = createRoot(document.createElement("div")), sessions = new WritingFileSessions();
  sessions.open({manuscriptId: "m", relativePath: "main.tex"}, "main candidate", "main");
  sessions.open({manuscriptId: "m", relativePath: "second.tex"}, "second candidate", "second");
  const files: readonly ManuscriptFile[] = ["main.tex", "second.tex"].map(path => ({manuscriptId: "m", relativePath: parseManuscriptPath(path), kind: "tex", sha256: path, sizeBytes: 10, modifiedAt: "now"}));
  const gateway = {listFiles: vi.fn(async () => files), listCitationBindings: vi.fn(async () => [])};
  const options: Options = {enabled: true, manuscriptId: "m", activePath: "main.tex", files,
    gateway: gateway as unknown as Options["gateway"], citationKeys: {reconcile: vi.fn(async () => false)}, fileSessions: sessions,
    setFiles: vi.fn(), setCitationBindings: vi.fn(), setContent: vi.fn(), setContentHash: vi.fn(), markSourceChanged: vi.fn(), setError: vi.fn()};
  function Host({value}: {value: Options}) {useWritingCitationReconciliation(value); return null;}
  return {options, gateway, render: (patch: Partial<Options> = {}) => {Object.assign(options, patch); return act(async () => root.render(<Host value={{...options}}/>));},
    dispose: () => act(async () => root.unmount())};
}

it("does not recheck on file selection but still checks changed committed metadata and explicit readiness", async () => {
  const h = harness();
  try {
    await h.render();
    await h.render({activePath: "second.tex"}); await h.render({activePath: "main.tex"});
    expect(h.options.citationKeys.reconcile).toHaveBeenCalledExactlyOnceWith("m");
    expect(h.gateway.listFiles).not.toHaveBeenCalled();
    await h.render({files: h.options.files.map(file => ({...file, sha256: "changed"}))});
    expect(h.options.citationKeys.reconcile).toHaveBeenCalledTimes(2);
    await h.render({enabled: false}); await h.render({enabled: true});
    expect(h.options.citationKeys.reconcile).toHaveBeenCalledTimes(3);
  } finally {await h.dispose();}
});

it("publishes the latest visible file after an in-flight key change without restarting it", async () => {
  const h = harness(); let finish!: (changed: boolean) => void;
  vi.mocked(h.options.citationKeys.reconcile).mockImplementationOnce(() => new Promise(done => {finish = done;}));
  try {
    await h.render(); await h.render({activePath: "second.tex"});
    await act(async () => finish(true));
    expect(h.options.citationKeys.reconcile).toHaveBeenCalledOnce();
    expect(h.options.setContent).toHaveBeenCalledExactlyOnceWith("second candidate");
    expect(h.options.setContentHash).toHaveBeenCalledWith("second");
    expect(h.options.markSourceChanged).toHaveBeenCalledOnce();
  } finally {await h.dispose();}
});

it.each(["project", "busy"] as const)("ignores late metadata after a %s transition", async kind => {
  const h = harness(); let finish!: (files: readonly ManuscriptFile[]) => void;
  vi.mocked(h.options.citationKeys.reconcile).mockResolvedValueOnce(true);
  h.gateway.listFiles.mockImplementationOnce(() => new Promise(done => {finish = done;}));
  try {
    await h.render();
    await h.render(kind === "project" ? {manuscriptId: "other"} : {enabled: false});
    await act(async () => finish(h.options.files));
    expect(h.options.setFiles).not.toHaveBeenCalled(); expect(h.options.setContent).not.toHaveBeenCalled();
  } finally {await h.dispose();}
});

it("preserves actionable reconciliation errors", async () => {
  const h = harness(); vi.mocked(h.options.citationKeys.reconcile).mockRejectedValueOnce(new Error("citation_conflict: synthetic operation"));
  try {await h.render(); expect(h.options.setError).toHaveBeenCalledWith("citation_conflict: synthetic operation");}
  finally {await h.dispose();}
});
