import {PreviewWorkbench, type PreviewWorkbenchProps} from "@research-assistant/workbench-preview/preview-workbench";
import {loadBrowserPlugins} from "./runtime/plugins/loadBrowserPlugins";

export function App(props: Omit<PreviewWorkbenchProps, "loadPlugins"> = {}) {
  return <PreviewWorkbench loadPlugins={loadBrowserPlugins} {...props}/>;
}
