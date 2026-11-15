import {parseManuscriptPath} from "@research-assistant/writing";
import {readWorkspaceState} from "@research-assistant/workbench-sdk/workspace-state";
import type {WritingProjectTabState} from "./WritingProjectTabs";

export function decodeWritingTabs(value: unknown): readonly WritingProjectTabState[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0,128).flatMap(row => {
    if (!row || typeof row.manuscriptId !== "string" || !row.manuscriptId || seen.has(row.manuscriptId) || !Array.isArray(row.openPaths)) return [];
    seen.add(row.manuscriptId);
    const paths: string[] = [];
    for (const path of row.openPaths.slice(0,256)) {
      try { if (typeof path === "string" && !paths.includes(path)) paths.push(parseManuscriptPath(path)); } catch { /* Invalid presentation paths grant no access. */ }
    }
    return [{manuscriptId:row.manuscriptId,openPaths:paths,
      activePath:paths.includes(row.activePath) ? row.activePath : undefined,
      previewPath:paths.includes(row.previewPath) ? row.previewPath : undefined,
      cursorState:row.cursorState && typeof row.cursorState === "object" ? Object.fromEntries(Object.entries(row.cursorState).filter((entry): entry is [string,number]=>typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0)) : {},
      layoutState:row.layoutState && typeof row.layoutState === "object" && !Array.isArray(row.layoutState) ? row.layoutState : {}}];
  });
}
export const loadWritingTabs = () => readWorkspaceState("writing-projects",[],decodeWritingTabs);
