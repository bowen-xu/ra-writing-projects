import { resolveWritingRuntimeGateway } from "@research-assistant/workbench-sdk/writing-runtime";

import { browserWritingGateway } from "./browserWritingGateway";
import type { WritingGateway } from "./writingGateway";
import { observeWritingNotes } from "./observeWritingNotes";

export function getWritingGateway(): WritingGateway {
  return observeWritingNotes(resolveWritingRuntimeGateway(browserWritingGateway));
}

export type { WritingGateway } from "./writingGateway";
