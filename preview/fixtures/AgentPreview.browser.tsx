/** Application-owned browser test data entry. No normal App route imports it.
 * Only finite synthetic IO and lifecycle methods cross this test boundary. */
export {
  configureAgentPreview, configureLiveAgentResponse, holdLiveAgentOutput, liveAgentTurnIds,
  configureFailedAgentHistory, installLiveContextCatalog, holdAgentMetadata, agentMetadataBlocked, releaseAgentMetadata,
  installAgentStartFailure, createPreviewNote, createBrowserLinkNote,
  configureBrowserOpenFailure, recordBrowserOpenings, readBrowserOpenings, readIndependentSubmissionTexts,
} from "@research-assistant/workbench-preview/live-agent-fixture";

export {
  holdLauncherPreparation, launcherPreparationReached, failHeldLauncherPreparation,
  refreshLauncherActivity, setLauncherInternalActivity, selectLauncherOpenAiModel,
} from "@research-assistant/workbench-preview/launcher-preview-fixture";

export {
  seedToolJournal, preparePendingToolJournal, configureToolResources,
  readToolHistoryCallIds, selectWritingJournal, originalToolHistorySteps,
} from "../src/app/previews/agent/ToolJournalFixture";
export type {ToolJournalFixture, ToolJournalStep} from "../src/app/previews/agent/ToolJournalFixture";
