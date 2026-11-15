import type { SourceLineRange } from "@research-assistant/core/source";
export interface WritingFocusRequest {
  readonly line: number;
  readonly blockId?: string;
  readonly token: number;
  readonly range?: SourceLineRange;
  readonly onLocated?: (location?: import("@research-assistant/workbench-sdk/source-navigation").SourceNavigationLocation) => void;
  readonly onError?: (reason: unknown) => void;
}
