import type {AppRuntime} from "@research-assistant/workbench-preview/app-runtime";
import {configureLiteratureWorkbench} from "@research-assistant/literature-library-preview";
import {configureWritingWorkbench} from "./writing/configureWritingWorkbench";

/** The default product uses the same concrete adapters as selected static
 * products. Full mock runtimes still retain their explicitly supplied owners. */
export function configureBuiltinServices(runtime: AppRuntime): void {
  configureLiteratureWorkbench(runtime);
  configureWritingWorkbench(runtime);
}
