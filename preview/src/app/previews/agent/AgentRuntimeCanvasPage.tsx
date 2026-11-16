import { getAppRuntime } from "@research-assistant/workbench-preview/app-runtime";
import { NativeAgentCanvasPreview } from "./NativeAgentCanvasPreview";
import { AgentCanvasPreviewFrame } from "@research-assistant/workbench-preview/agent-canvas-preview-frame";
import { AgentCanvasScenarioControls } from "@research-assistant/workbench-preview/agent-canvas-scenario-controls";
import { DEFAULT_CANVAS_TEXT_SETTINGS } from "@research-assistant/workbench-preview/agent-canvas-text-settings";

/** The public route always keeps the original harness and requires native execution. */
export function AgentRuntimeCanvasPage(): React.JSX.Element {
  if (getAppRuntime().nativeAgentPreview) return <NativeAgentCanvasPreview />;
  const unavailable = () => { throw new Error("CANVAS_NATIVE_BACKEND_REQUIRED"); };
  return <AgentCanvasPreviewFrame controls={<AgentCanvasScenarioControls scenario="running" duration={60}
    settings={DEFAULT_CANVAS_TEXT_SETTINGS} disabled onScenario={unavailable} onDuration={unavailable}
    onSettings={unavailable} onReset={unavailable} />}>
    <p className="agent-canvas-demo-status" role="status">旧原生 HTTP 预览入口已归档。请运行 <code>pnpm dev:desktop</code>，在开发应用中验证动态插件与 Agent。</p>
  </AgentCanvasPreviewFrame>;
}
