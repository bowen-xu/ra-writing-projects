/** Compatibility access to the existing Core-owned typed Git version capability. */
export { getManuscriptVersionGateway } from "@research-assistant/workbench-sdk/git-versions";
export type { ManuscriptVersionCommit, ManuscriptVersionHistory, ManuscriptVersionGateway, GitRestoreScope, ManuscriptGitRestoreProposal, GitRepositoryView, ManuscriptGitBranches, ManuscriptVersionDiff, HistoricalVersionFile } from "./contracts/gitVersionGateway";
