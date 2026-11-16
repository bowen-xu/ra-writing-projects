import type {AppRuntime} from "@research-assistant/workbench-preview/app-runtime";
import {getWritingGateway} from "../../../../../src/public/writingGateway.ts";
import {tauriWritingGateway} from "@research-assistant/workbench-preview/tauri-writing-gateway";
import {tauriWritingCheckpointGateway} from "@research-assistant/workbench-preview/tauri-writing-checkpoint-gateway";
import {tauriWritingNoteAssetGateway} from "@research-assistant/workbench-preview/tauri-writing-note-asset-gateway";

export function configureWritingWorkbench(runtime: AppRuntime): void {
  if (runtime.mode === "preview" && !runtime.nativeAgentPreview) return;
  if (runtime.mode === "desktop" || runtime.nativeAgentPreview)
    runtime.gateways.getWritingCheckpointGateway ??= tauriWritingCheckpointGateway;
  if (runtime.mode === "desktop") runtime.gateways.getWritingNoteAssetGateway ??= tauriWritingNoteAssetGateway;
  if (!runtime.gateways.getWritingGateway) {
    if (runtime.mode === "desktop" || runtime.nativeAgentPreview) runtime.gateways.getWritingGateway = tauriWritingGateway;
    runtime.gateways.getWritingGateway = getWritingGateway();
  }
}
