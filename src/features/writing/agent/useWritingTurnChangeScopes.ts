import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentConversationProjection, AgentWorkspaceScope } from "@research-assistant/core/agent";
import type { AgentWorkspaceReviewGateway } from "@research-assistant/data/agent";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import { diagnosticError } from "@research-assistant/workbench-sdk/agent-diagnostics";

const noSubscription = (): (() => void) => () => undefined;
const emptyScopes: ReadonlyMap<string, AgentWorkspaceScope> = new Map();

/** Read-only history lookup. Never infer ownership from the latest reply or
 * current file content, and never clear earlier cards when another turn starts. */
export function useWritingTurnChangeScopes({ conversationId, manuscriptId, projection, gateway, fileSessions }: {
  readonly conversationId: string | null;
  readonly manuscriptId: string | undefined;
  readonly projection: AgentConversationProjection | null;
  readonly gateway: AgentWorkspaceReviewGateway;
  readonly fileSessions: WritingFileSessions | undefined;
}): { readonly scopes: ReadonlyMap<string, AgentWorkspaceScope>; readonly publishedProposals: ReadonlyMap<string, string>; readonly failed: boolean; readonly error: string | null; readonly retry: () => void } {
  const completed = JSON.stringify(projection?.conversationId === conversationId ? projection.turnOrder.flatMap(turnId => {
    const turn = projection.turns.get(turnId);
    return turn?.outcome ? [[turnId, turn.contextSnapshotId]] : [];
  }) : []);
  // Completion may precede durable proposal publication. File operation arrival
  // permits rediscovery; typing, Keep/Undo and other conversations do not.
  const deliveries = useSyncExternalStore(fileSessions?.subscribe ?? noSubscription,
    () => JSON.stringify(manuscriptId ? fileSessions?.forManuscript(manuscriptId).flatMap(session =>
      session.readOperations().filter(operation => operation.conversationId === conversationId)
        .map(operation => [session.identity.relativePath, operation.operationId])) ?? [] : []));
  const scopeIdentity = JSON.stringify([manuscriptId, conversationId]);
  const [storedScopes, setStoredScopes] = useState<{identity: string; scopes: ReadonlyMap<string, AgentWorkspaceScope>; published: ReadonlyMap<string, string>}>(
    () => ({identity: scopeIdentity, scopes: emptyScopes, published: new Map()}),
  );
  const [failure, setFailure] = useState<{identity: string; message: string | null}>(() => ({identity: scopeIdentity, message: null}));
  const scopes = storedScopes.identity === scopeIdentity ? storedScopes.scopes : emptyScopes;
  const error = failure.identity === scopeIdentity ? failure.message : null;
  const failed = error !== null;
  const [attempt, setAttempt] = useState(0);
  const currentScope = useRef(scopeIdentity);
  currentScope.current = scopeIdentity;
  useEffect(() => {
    let current = true;
    const turns = new Map<string, string>(JSON.parse(completed));
    if (!conversationId || !manuscriptId || !turns.size) {
      setFailure({identity: scopeIdentity, message: null});
      return;
    }
    void (async () => {
      const found = new Map<string, AgentWorkspaceScope>();
      const published = new Map<string, string>();
      let cursor: string | null = null;
      do {
        const page = await gateway.list({ conversationId, manuscriptId, cursor, limit: 100 });
        if (!current) return;
        for (const entry of page.entries) {
          if (turns.get(entry.turnId) === entry.scope.contextSnapshotId) {
            found.set(entry.turnId, entry.scope);
            if (entry.publishedProposalId) published.set(entry.turnId, entry.publishedProposalId);
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      if (current) {
        setStoredScopes({identity: scopeIdentity, scopes: found, published});
        setFailure({identity: scopeIdentity, message: null});
      }
    })().catch((reason: unknown) => {
      if (!current) return;
      const detail = diagnosticError(reason);
      const fields = [`code=${typeof detail.code === "string" ? detail.code : "WRITING_CHANGE_HISTORY_READ_FAILED"}`,
        `conversation=${conversationId}`, `manuscript=${manuscriptId}`,
        ...(typeof detail.requestId === "string" ? [`request=${detail.requestId}`] : []),
        ...(typeof detail.httpStatus === "number" ? [`http=${detail.httpStatus}`] : []),
        ...(typeof detail.cause === "string" ? [`cause=${detail.cause}`] : [])];
      setFailure({identity: scopeIdentity, message: `无法读取本轮文件变更。 [${fields.join("；")}]`});
    });
    return () => { current = false; };
  }, [conversationId, manuscriptId, completed, deliveries, gateway, attempt, scopeIdentity]);
  return { scopes, publishedProposals: storedScopes.identity === scopeIdentity ? storedScopes.published : new Map(), failed, error, retry: () => {if (currentScope.current === scopeIdentity) setAttempt(value => value + 1);} };
}
