import {createElement} from "react";
import type {PluginActivationContext, PluginWritingRuntimeProps} from "@research-assistant/workbench-sdk/activation";
import {WritingWorkspace} from "./public/workspace";
import {WritingFileRuntimeProvider} from "./public/fileRuntime";
import {WritingConversationSession} from "./public/conversationSession";

export {writingProjectsManifest} from "./public/manifest";
export {writingConfiguration as configuration} from "./public/configuration";

function WritingRuntime(props: PluginWritingRuntimeProps): React.JSX.Element {
  return createElement(WritingFileRuntimeProvider, {runtime: props, children: null});
}

/** The Core registration retains the original three production roles together. */
export function activate(context: PluginActivationContext): void {
  const view = context.registerView({
    id: "writing", title: "写作", priority: 100,
    writing: {Runtime: WritingRuntime, Session: WritingConversationSession},
    render({active, writingWorkspace}) {
      if (!writingWorkspace) throw new Error("plugin_workspace_host_unavailable:writing_projects/writing");
      return createElement(WritingWorkspace, {...writingWorkspace,
        tabsActive: active && writingWorkspace.tabsActive !== false});
    },
  });
  context.onDispose(() => view.dispose());
}
