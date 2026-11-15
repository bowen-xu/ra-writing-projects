import type {ConfigurationSetting, PluginConfigurationDeclaration} from "@research-assistant/workbench-sdk/configuration";

export const writingOutlineSetting: ConfigurationSetting<boolean> = {
  key: "outlineVisible", defaultValue: true, schema: {type: "boolean"}, scopes: ["application", "resource"], effect: "immediate",
};
export const writingConfiguration = {owner: "writing_projects", settings: [writingOutlineSetting]} satisfies PluginConfigurationDeclaration;
