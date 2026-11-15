import {useSyncExternalStore} from "react";
import type {AgentDomainSessionProps} from "@research-assistant/workbench-sdk/agent-presentation";
import {useAgentConversation} from "@research-assistant/workbench-sdk/agent-conversations";
import {projectConversationMessages} from "@research-assistant/workbench-sdk/agent-conversations";
import {openAgentConversation} from "@research-assistant/workbench-sdk/agent-ui";
import {WritingAgentRuntimePanel} from "../WritingAgentRuntimePanel";
import {useWritingFileRuntime, useWritingProjectFiles} from "../persistence/WritingFileRuntimeProvider";
import {readWritingSubmissionBuffers} from "./writingSubmissionSources";
import {notify} from "@research-assistant/workbench-sdk/feedback";

/** Project execution without a project page, editor view, or workspace tab. */
export function WritingConversationSession({id, directory, title, archived, open, onOpenChange, headerControls, onRenamed, messageRequest}: AgentDomainSessionProps): React.JSX.Element {
  const owner = useWritingFileRuntime(), applications = useWritingProjectFiles(directory.manuscriptId);
  const history = useAgentConversation(id), metadata = owner.getMetadata(directory.manuscriptId);
  const error = useSyncExternalStore(owner.subscribe, () => owner.getFailure(directory.manuscriptId));
  return <WritingAgentRuntimePanel messageRequest={messageRequest ?? null} manuscriptId={directory.manuscriptId} conversationId={id} conversationTitle={title}
    open={open} onOpenChange={onOpenChange} headerControls={headerControls} showLauncher={false} archived={archived}
    files={metadata?.files ?? []} activePath={undefined} content="" contentHash={undefined} fileSessions={owner.files}
    readFileBuffers={() => readWritingSubmissionBuffers(directory.manuscriptId, owner.files, owner.access.gateway)}
    {...(applications ? {onSubmissionAdmitted: applications.agentDelivery.register, fileDeliveries: applications.agentDelivery.entries,
      undoProposal: applications.undoProposal} : {})}
    metadataLoading={!error && !applications?.filesReady} {...(error ? {metadataUnavailable: error} : {})}
    onRetryMetadata={() => owner.retry(directory.manuscriptId)} onConversationTitleChanged={onRenamed}
    messages={projectConversationMessages(history.projection)} projection={history.projection}
    historyReady={history.status === "ready"} historyError={history.status === "error"}
    onOpenConversation={conversation => {void openAgentConversation(conversation.id).catch(reason => notify.error(String(reason)));}}/>;
}
