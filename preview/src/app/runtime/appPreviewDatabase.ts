import {installPreviewDatabaseFactory} from "@research-assistant/workbench-preview/preview-indexed-database";
import {openAppPreviewDatabase} from "@research-assistant/workbench-preview/preview-database";
export {openAppPreviewDatabase} from "@research-assistant/workbench-preview/preview-database";
installPreviewDatabaseFactory(openAppPreviewDatabase);
