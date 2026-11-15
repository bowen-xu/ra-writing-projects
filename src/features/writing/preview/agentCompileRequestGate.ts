/**
 * Fences asynchronous reads and SyncTeX requests for the currently selected
 * Agent compile result. A late response from an older result must never
 * repopulate the shared PDF viewer or its location marker.
 */
export interface AgentCompileRequestGate {
  invalidate(): void;
  begin(): number;
  isCurrent(epoch: number): boolean;
}

export function createAgentCompileRequestGate(): AgentCompileRequestGate {
  let epoch = 0;
  return {
    invalidate: () => { epoch += 1; },
    begin: () => { epoch += 1; return epoch; },
    isCurrent: (requestEpoch) => requestEpoch === epoch,
  };
}
