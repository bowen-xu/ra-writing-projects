/** Compatibility access to the existing Core-owned typed Git version capability. */
export { getManuscriptVersionGateway } from "../../../../apps/web/src/core/public/gitVersions";
export type { ManuscriptVersionCommit, ManuscriptVersionHistory, ManuscriptVersionGateway, GitRestoreScope, ManuscriptGitRestoreProposal, GitRepositoryView, ManuscriptGitBranches, ManuscriptVersionDiff, HistoricalVersionFile } from "./contracts/gitVersionGateway";
