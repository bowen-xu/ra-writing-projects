import {useState, type PropsWithChildren} from "react";
import {writingConfiguration} from "@research-assistant/writing-projects-preview/configuration";
import {PluginConfigurationProvider} from "@research-assistant/workbench-preview/configuration-provider";
import {createPluginConfigurations} from "@research-assistant/workbench-preview/configuration";
import {getAppStorage} from "@research-assistant/workbench-preview/app-storage";

export function BuiltinPluginConfigurationTest({owner, children}: PropsWithChildren<{owner: string}>) {
  if (owner !== "writing_projects") throw new Error("unexpected_configuration_fixture_owner");
  const [configuration] = useState(() => createPluginConfigurations(getAppStorage(), [{owner, declaration: writingConfiguration, storage: {outlineVisible: {application: "research-assistant:workspace.v1:writing-outline", resourcePrefix: "research-assistant:workspace.v1:writing-outline:"}}}]).get(owner)!);
  return <PluginConfigurationProvider value={configuration}>{children}</PluginConfigurationProvider>;
}
