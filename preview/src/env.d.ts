declare const __APP_VERSION__: string;
declare const __RUNTIME_PLUGINS__: boolean;

interface ImportMeta {
  readonly env: { readonly VITE_WRITING_STATE_TRACE?: string; readonly VITE_NATIVE_COMMAND_TRACE?: string; readonly VITE_AGENT_RUNTIME_PREVIEW?: string; readonly VITE_AGENT_RUNTIME_PREVIEW_INSTANCE?: string };
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*.md?raw" {
  const text: string;
  export default text;
}

declare module "virtual:workbench-composition" {
  export const composition: import("@research-assistant/workbench-preview").WorkbenchComposition;
}
