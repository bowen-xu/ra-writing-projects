import "./appPreviewDatabase";
import {configureBuiltinServices} from "./configureBuiltinServices";
import { isTauri } from "@tauri-apps/api/core";
import { PREVIEW_STORAGE_PREFIX, selectAppStorage } from "@research-assistant/workbench-preview/app-storage";
import { createIndexedPreviewStorage } from "@research-assistant/workbench-preview/preview-indexed-storage";
import { withPreviewPersistence } from "@research-assistant/workbench-preview/preview-persistence-runtime";
import { flushStorage } from "@research-assistant/workbench-preview/storage-persistence";
import { selectAppRuntime, type AppRuntime } from "@research-assistant/workbench-preview/app-runtime";
import { isSourceNavigationPreview } from "@research-assistant/workbench-preview/source-navigation-preview";
import { readWritingRecoveryScenario } from "@research-assistant/workbench-preview/writing-recovery-preview";
import {readNoteRecoveryScenario} from "@research-assistant/workbench-preview/note-recovery-preview";
import { readNoteOpeningScenario, mockNoteOpening } from "./mock/mockNoteOpening";

/** Both full-App preview URLs select the same isolated mock environment. */
export function isAppPreviewRequest(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("preview") === "notes" || params.get("preview") === "app" || params.get("demo") === "app" || params.get("demo") === "text-patch";
}

export async function createAppRuntime(search: string, backing: Storage): Promise<AppRuntime> {
  if (isAppPreviewRequest(search)) {
    const sourcePreview = isSourceNavigationPreview(search);
    const params = new URLSearchParams(search);
    const textPatch = params.get("demo") === "text-patch" || params.get("preview") === "notes";
    const bibliographyPreview = new URLSearchParams(search).get("bibliography") === "1";
    const writingRecovery = readWritingRecoveryScenario(search);
    const noteRecovery = readNoteRecoveryScenario(search);
    const noteOpening = readNoteOpeningScenario(search);
    const prefix = noteOpening ? `research-assistant.note-opening-preview.v1:${noteOpening}:` : noteRecovery ? `research-assistant.note-recovery-preview.v1:${noteRecovery}:` : bibliographyPreview ? "research-assistant.bibliography-preview.v3:" : writingRecovery ? `research-assistant.writing-recovery-preview.v3:${writingRecovery}:`
      : sourcePreview ? "research-assistant.source-preview.v3:"
      : textPatch ? "research-assistant.text-patch-preview.v5:" : PREVIEW_STORAGE_PREFIX;
    const storage = await createIndexedPreviewStorage(prefix);
    selectAppStorage(storage);
    selectAppRuntime({ mode: "browser", storage, gateways: {}, dispose() {} });
    const { createMockAppRuntime } = await import("./mock/createMockAppRuntime");
    const runtime = withPreviewPersistence(await createMockAppRuntime(storage, { sourceNavigation: sourcePreview, textPatch, bibliographyPreview, ...(writingRecovery ? { writingRecovery } : {}), ...(noteRecovery ? {noteRecovery} : {}) }));
    if (noteOpening && runtime.gateways.getNotesGateway) {
      const { TEXT_PATCH_PREVIEW_PAGE } = await import("./mock/mockTextPatchGateway");
      runtime.gateways.getNotesGateway = mockNoteOpening(runtime.gateways.getNotesGateway, noteOpening, TEXT_PATCH_PREVIEW_PAGE);
    }
    await flushStorage(storage);
    selectAppRuntime(runtime);
    return runtime;
  }
  const runtime: AppRuntime = { mode: isTauri() ? "desktop" : "browser", storage: backing, gateways: {}, dispose() {} };
  selectAppRuntime(runtime);
  configureBuiltinServices(runtime);
  return runtime;
}
