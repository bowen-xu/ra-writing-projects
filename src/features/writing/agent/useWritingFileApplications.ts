import { createElement, Fragment, useMemo } from "react";
import type { AgentPendingWritingApplicationGateway, AgentPendingWritingUndoGateway, AgentProposalGateway } from "@research-assistant/data/agent";
import { agentApplicationGateway, agentPendingWritingApplicationGateway, agentPendingWritingUndoGateway, agentProposalGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { createWritingEditorApplication } from "../editor/editorApplication";
import { createWritingEditorDelivery, createWritingFileOperationDelivery } from "../editor/writingEditorDelivery";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { WritingCheckpointPersistence } from "../persistence/WritingCheckpointPersistence";
import { useWritingBackgroundRecovery } from "../persistence/useWritingBackgroundRecovery";
import type { PendingFileConflict } from "../useWritingPersistence";
import { useWritingAgentFileDelivery, type WritingAgentFileDeliveryGateways } from "./useWritingAgentFileDelivery";
import { desktopWritingApplicationGateways, useWritingProposalApplication, type WritingProposalApplicationGateways } from "./useWritingProposalApplication";
import { createWritingCardUndo } from "./writingCardUndo";
import { useWritingUndoRecovery } from "./useWritingUndoRecovery";
import { WritingFileRecoveryFeedback } from "./WritingFileRecoveryFeedback";
import { useWritingApplicationRecovery, WritingApplicationRecoveryFeedback } from "./useWritingApplicationRecovery";

export interface WritingFileApplicationGateways {
  readonly delivery: WritingAgentFileDeliveryGateways & { readonly proposals: AgentProposalGateway };
  readonly application: WritingProposalApplicationGateways;
  readonly pendingUndos: AgentPendingWritingUndoGateway;
  readonly pendingApplications: AgentPendingWritingApplicationGateway;
}
interface Options extends Omit<Parameters<typeof useWritingProposalApplication>[0], "editor" | "readFileBuffers" | "resolveFilePort" | "agentGateways"> {
  /** A view using the application owner must not attach a second I/O lifecycle. */
  readonly observeOnly?: boolean;
  readonly files: WritingFileSessions;
  readonly checkpoints: WritingCheckpointPersistence;
  readonly manuscriptId: string | undefined;
  readonly ready: boolean;
  readonly onFileConflict: (conflict: PendingFileConflict) => void;
  readonly agentGateways?: WritingFileApplicationGateways;
  /** Stop new delivery admission while keeping original recovery/ACK paths live. */
  readonly admissionsBlocked?: boolean;
}

/** One file-owned composition for the workspace and gateway-backed previews.
 * Chat views never own completion subscriptions or application/checkpoint delivery.
 */
export function useWritingFileApplications(options: Options) {
  const { agentGateways, ...hostOptions } = options;
  const manuscriptId = options.observeOnly ? undefined : options.manuscriptId;
  const background = useWritingBackgroundRecovery({ manuscriptId, ready: options.ready,
    gateway: options.access.gateway, checkpoints: options.checkpoints, onFileConflict: options.onFileConflict });
  const applicationGateway = options.agentGateways?.application.applications ?? agentApplicationGateway;
  const proposals = options.agentGateways?.delivery.proposals ?? agentProposalGateway;
  const editor = useMemo(() => createWritingEditorApplication(applicationGateway,
    (scope, path) => options.files.get({ manuscriptId: scope.manuscriptId, relativePath: path })?.applicationPort ?? null,
    createWritingEditorDelivery(options.files, options.checkpoints, proposals)),
  [applicationGateway, proposals, options.files, options.checkpoints]);
  const applicationActions = useWritingProposalApplication({ ...hostOptions, editor,
    readHost: () => { const host = options.readHost(); return { ...host, ready: host.ready && background.ready }; },
    operationDelivery: original => createWritingFileOperationDelivery(options.files, options.checkpoints, original),
    readFileBuffers: (manuscriptId) => options.files.readBuffers(manuscriptId),
    prepareUndoResume: manuscriptId => options.checkpoints.captureUndoCheckpointVersions(manuscriptId),
    resolveFilePort: (scope, path) => options.files.get({ manuscriptId: scope.manuscriptId, relativePath: path })?.applicationPort ?? null,
    ...(agentGateways ? { agentGateways: agentGateways.application } : {}),
  });
  const applicationGateways = agentGateways?.application ?? desktopWritingApplicationGateways;
  const undoRecovery = useWritingUndoRecovery(manuscriptId, options.ready && background.ready, applicationGateways.undos, applicationActions,
    agentGateways?.pendingUndos ?? agentPendingWritingUndoGateway, options.files);
  const applicationRecovery = useWritingApplicationRecovery(manuscriptId,
    agentGateways?.pendingApplications ?? agentPendingWritingApplicationGateway, options.files);
  const recoveryCommands = { gateway: applicationGateway, accept: applicationActions.accept, recover: applicationActions.recover, rollback: applicationActions.rollback };
  const delivery = useWritingAgentFileDelivery({ manuscriptId,
    ready: options.ready && background.ready && !undoRecovery.pending, mutationsBlocked: options.admissionsBlocked || applicationRecovery.pending,
    gateway: options.access.gateway, files: options.files, checkpoints: options.checkpoints, accept: async scope => {
      const result = await applicationActions.accept(scope);
      if ("state" in result && result.state) applicationRecovery.record(result.state, result);
      return result;
    },
    recovery: recoveryCommands, onApplicationError: applicationRecovery.observe,
    ...(options.agentGateways ? { agentGateways: options.agentGateways.delivery } : {}),
  });
  const undoProposal = useMemo(() => createWritingCardUndo(applicationGateways,
    applicationActions, undoRecovery.record), [applicationGateways, applicationActions, undoRecovery.record]);
  return { applicationActions, filesReady: background.ready, agentDelivery: { ...delivery,
    hasPending: () => delivery.hasPending() || applicationRecovery.hasPending() || undoRecovery.hasPending() || background.hasPending(),
    pending: delivery.pending || applicationRecovery.pending || undoRecovery.pending || background.pending }, undoProposal, undoRecovery,
    recoveryFeedback: createElement(WritingFileRecoveryFeedback, { delivery: createElement(Fragment, null, background.feedback, delivery.feedback,
      createElement(WritingApplicationRecoveryFeedback, { recovery: applicationRecovery, commands: recoveryCommands,
        silentOperationIds: delivery.entries.filter(entry => entry.toolOwned && entry.application).map(entry => entry.application!.scope.operationId),
        ready: options.ready && background.ready && !undoRecovery.pending, onResult: delivery.recordRecoveredApplication })), undo: undoRecovery.feedback }) };
}
