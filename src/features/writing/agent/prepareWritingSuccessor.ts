import type { AgentWorkspaceSuccessorGateway } from "@research-assistant/data/agent";
import type { WritingGateway } from "../gateway";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import { readWritingSubmissionBuffers } from "./writingSubmissionSources";
import type { WritingSuccessorToolGateway, WritingSuccessorToolRequest } from "@research-assistant/workbench-sdk/agent-delivery";

/** Prepare exactly the requested successor, failing closed if its editor owner changes. */
export async function prepareWritingSuccessor(request: WritingSuccessorToolRequest, options: {
  readonly current: () => { readonly manuscriptId: string | undefined; readonly ready: boolean; readonly mutationsBlocked?: boolean;
    readonly files: WritingFileSessions; readonly gateway: Pick<WritingGateway, "readFile"> } | null;
  readonly workspaces: AgentWorkspaceSuccessorGateway;
  readonly tools: WritingSuccessorToolGateway;
}): Promise<void> {
  let confirmation = null;
  try {
    const host = options.current();
    if (!host || !host.ready || host.mutationsBlocked || host.manuscriptId !== request.scope.manuscriptId) throw new Error("file owner unavailable");
    const buffers = await readWritingSubmissionBuffers(host.manuscriptId, host.files, host.gateway);
    const { requestId: _requestId, ...identity } = request;
    const prepared = await options.workspaces.prepare({ ...identity, buffers });
    const current = options.current();
    if (!current || !current.ready || current.mutationsBlocked || current.manuscriptId !== host.manuscriptId || current.files !== host.files) throw new Error("file owner changed");
    const latest = current.files.readBuffers(host.manuscriptId);
    if (latest.length !== buffers.length || buffers.some(buffer => !latest.some(value => value.path === buffer.path
      && value.sessionId === buffer.sessionId && value.revision === buffer.revision && value.text === buffer.text))) throw new Error("file buffers changed");
    confirmation = prepared;
  } catch { /* A failed or uncertain preparation must never authorize execution. */ }
  await options.tools.report({ request, confirmation });
}
