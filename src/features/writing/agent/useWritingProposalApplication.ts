import { useEffect, useMemo, useRef } from "react";
import type { AgentApplicationScope, AgentEditorSessionPort, AgentWorkspaceBuffer, AgentUndoCheckpointVersion } from "@research-assistant/core/agent";
import type { BibliographyStatus, CitationBinding, Manuscript, ManuscriptDirectory, ManuscriptFile } from "@research-assistant/writing";
import { agentApplicationGateway, agentEditorRestorationGateway, agentUndoGateway, getAgentUndoEditorRestorationGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { createWritingEditorUndo } from "../editor/editorUndo";
import { createWritingProposalUndo } from "./writingProposalUndo";
import { recoverWritingUndo } from "./writingUndoRecovery";
import { rollbackWritingUndo } from "./writingUndoRollback";
import { createWritingEditorRestoration } from "../editor/editorRestoration";
import type { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import type { WritingPersistenceControl } from "../useWritingPersistence";
import type { createWritingEditorApplication, EditorApplicationResult, WritingEditorDelivery } from "../editor/editorApplication";
import { acquireWritingApplicationLease, type WritingApplicationHostSnapshot } from "./writingApplicationLease";
import { createWritingProposalApplication } from "./writingProposalApplication";
import { recoverWritingApplication } from "./writingApplicationRecovery";
import { rollbackWritingApplication } from "./writingApplicationRollback";
import type { WritingFileSaveQueue } from "../persistence/WritingFileSaveQueue";

export type AcceptWritingProposal = (scope: AgentApplicationScope) => Promise<EditorApplicationResult>;
export interface WritingApplicationMetadata {
  readonly files: readonly ManuscriptFile[];
  readonly directories: readonly ManuscriptDirectory[];
  readonly citations: readonly CitationBinding[];
  readonly bibliography: BibliographyStatus;
  readonly manuscripts: readonly Manuscript[];
}
export interface WritingProposalApplicationGateways {
  readonly applications: typeof agentApplicationGateway;
  readonly restorations: typeof agentEditorRestorationGateway;
  readonly undos: typeof agentUndoGateway;
  readonly undoRestorations: typeof getAgentUndoEditorRestorationGateway;
}
export const desktopWritingApplicationGateways: WritingProposalApplicationGateways = {
  applications: agentApplicationGateway, restorations: agentEditorRestorationGateway,
  undos: agentUndoGateway, undoRestorations: getAgentUndoEditorRestorationGateway,
};
interface Options {
  readonly access: ReturnType<typeof createExclusiveWritingGateway>;
  readonly persistence: WritingPersistenceControl;
  readonly editor: ReturnType<typeof createWritingEditorApplication>;
  readonly readHost: () => WritingApplicationHostSnapshot;
  readonly readFileBuffers?: (manuscriptId: string) => readonly AgentWorkspaceBuffer[];
  readonly prepareUndoResume?: (manuscriptId: string) => Promise<readonly AgentUndoCheckpointVersion[]>;
  readonly resolveFilePort?: (scope: AgentApplicationScope, path: string) => AgentEditorSessionPort | null;
  readonly fileSaves?: Pick<WritingFileSaveQueue, "save">;
  readonly operationDelivery?: (original: AgentApplicationScope) => WritingEditorDelivery;
  readonly publishMetadata: (metadata: WritingApplicationMetadata) => void;
  readonly onBusyChange?: ((busy: boolean) => void) | undefined;
  readonly agentGateways?: WritingProposalApplicationGateways;
}

/** Workspace-owned: closing the review dialog does not dispose the operation. */
export function useWritingProposalApplication(options: Options) {
  const gateways = options.agentGateways ?? desktopWritingApplicationGateways;
  const latest = useRef(options);
  latest.current = options;
  const alive = useRef(false), running = useRef(false);
  useEffect(() => {
    alive.current = true;
    const publish = () => latest.current.onBusyChange?.(running.current || options.access.isExclusive());
    const unsubscribe = options.access.subscribe(publish);
    publish();
    return () => {alive.current = false; unsubscribe(); latest.current.onBusyChange?.(false);};
  }, [options.access]);
  return useMemo(() => {
    const acquire = (scope: AgentApplicationScope) => {
      const host = latest.current;
      return acquireWritingApplicationLease({scope, access: options.access, persistence: host.persistence,
        ...(host.readFileBuffers ? { readFileBuffers: () => latest.current.readFileBuffers?.(scope.manuscriptId) ?? [] } : {}),
        ...(host.prepareUndoResume ? { prepareUndoResume: () => host.prepareUndoResume!(scope.manuscriptId) } : {}),
        readHost: () => {const snapshot = latest.current.readHost(); return {...snapshot, ready: alive.current && snapshot.ready};},
        prepareRefresh: async () => {
          const gateway = options.access.gateway;
          const [files, directories, citations, bibliography, manuscripts] = await Promise.all([
            gateway.listFiles(scope.manuscriptId), gateway.listDirectories(scope.manuscriptId),
            gateway.listCitationBindings(scope.manuscriptId), gateway.getBibliographyStatus(scope.manuscriptId),
            gateway.listManuscripts(),
          ]);
          return () => latest.current.publishMetadata({files, directories, citations, bibliography, manuscripts});
        },
      });
    };
    const controller = createWritingProposalApplication(gateways.applications, options.editor, acquire);
    const resolveFilePort = (scope: AgentApplicationScope, path: string) => {
      const host = latest.current.readHost();
      if (!alive.current || !host.ready || host.manuscriptId !== scope.manuscriptId) return null;
      return latest.current.resolveFilePort ? latest.current.resolveFilePort(scope, path) : host.port;
    };
    const undoEditor = (scope: AgentApplicationScope, undoId: string) => createWritingEditorUndo(gateways.undos, scope, undoId, resolveFilePort,
      latest.current.operationDelivery?.(scope));
    const undoController = createWritingProposalUndo(gateways.undos, undoEditor, acquire);
    const persistCompletedEditor = async (result: EditorApplicationResult): Promise<EditorApplicationResult> => {
      if (result.kind !== "state" || !["applied", "rolledBack"].includes(result.state.status)) return result;
      const editorFiles = result.state.files.filter(file => file.target.kind === "editor"
        && (result.state.status === "applied" || file.phase === "restored"));
      if (!editorFiles.length) return result;
      const host = latest.current;
      const currentHost = host.readHost();
      if (!alive.current || !currentHost.ready || currentHost.manuscriptId !== result.state.scope.manuscriptId) {
        return { kind: "unconfirmed", state: result.state };
      }
      const fileSaves = host.fileSaves;
      if (fileSaves) {
        const saved = await Promise.allSettled(editorFiles
          .map((file) => fileSaves.save({ manuscriptId: result.state.scope.manuscriptId, relativePath: file.path })));
        return saved.some((item) => item.status === "rejected") ? { kind: "unconfirmed", state: result.state } : result;
      }
      const hostSnapshot = host.readHost();
      const activePath = hostSnapshot.activePath;
      const port = hostSnapshot.port;
      const snapshot = activePath === undefined || port === null ? null : port.read();
      if (activePath === undefined || snapshot === null || hostSnapshot.manuscriptId === undefined
        || snapshot.documentKey !== `${hostSnapshot.manuscriptId}:${activePath}`) {
        return {kind: "unconfirmed", state: result.state};
      }
      const synchronized = host.persistence.syncEditorSnapshot?.({
        manuscriptId: result.state.scope.manuscriptId,
        relativePath: activePath,
        content: snapshot.text,
      }) ?? true;
      if (!synchronized || !(await host.persistence())) return {kind: "unconfirmed", state: result.state};
      return result;
    };
    const run = async (action: () => Promise<EditorApplicationResult>, persistEditor = false): Promise<EditorApplicationResult> => {
      if (running.current) return {kind: "busy"};
      if (!alive.current) return {kind: "unavailable"};
      running.current = true;
      latest.current.onBusyChange?.(true);
      try {return await action().then(result => persistEditor ? persistCompletedEditor(result) : result);}
      finally {running.current = false; if (alive.current) latest.current.onBusyChange?.(options.access.isExclusive());}
    };
    return {
      accept: (scope: AgentApplicationScope) => run(() => controller.apply(scope), true),
      undo: (scope: AgentApplicationScope, undoId: string) => run(() => undoController.apply(scope, undoId), true),
      startUndo: (scope: AgentApplicationScope, undoId: string) => run(() => undoController.start(scope, undoId), true),
      resumeUndo: (scope: AgentApplicationScope, undoId: string) => run(() => undoController.resume(scope, undoId), true),
      rollbackUndo: (scope: AgentApplicationScope, undoId: string) => run(() => rollbackWritingUndo(scope, undoId, gateways.undos, acquire,
        createWritingEditorRestoration(gateways.undoRestorations(scope), resolveFilePort, latest.current.operationDelivery?.(scope))), true),
      recoverUndo: (scope: AgentApplicationScope, undoId: string, path: string) => run(() => recoverWritingUndo(scope, undoId, path, gateways.undos, undoEditor(scope, undoId), acquire)),
      cancelUndo: (scope: AgentApplicationScope, undoId: string) => run(async () => {
        try {
          const response = await gateways.undos.execute({ scope, undoId, command: { action: "cancelPending" } });
          return response.result?.kind === "state" ? { kind: "state", state: response.result } : { kind: "unconfirmed", state: null };
        } catch { return { kind: "unconfirmed", state: null }; }
      }),
      rollback: (scope: AgentApplicationScope) => run(() => rollbackWritingApplication({...scope}, gateways.applications, acquire,
        createWritingEditorRestoration(gateways.restorations, resolveFilePort, latest.current.operationDelivery?.(scope))), true),
      recover: (scope: AgentApplicationScope, path: string) => run(() => recoverWritingApplication(
        {...scope}, path, gateways.applications, options.editor, acquire)),
    };
  }, [options.access, options.editor, gateways]);
}
