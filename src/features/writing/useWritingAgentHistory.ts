import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgentConversation, type AgentConversationAccess } from "@research-assistant/workbench-sdk/agent-conversations";
import { useConversationMetadata } from "@research-assistant/workbench-sdk/agent-conversations";
import { type AgentConversationSummary, type AgentSearchHit } from "@research-assistant/core/agent";
import { projectConversationMessages } from "@research-assistant/workbench-sdk/agent-conversations";
import type { AgentMessageSearchTarget } from "@research-assistant/workbench-sdk/agent-conversations";
import { clearAgentSessionSelection, readAgentSessionSelection, writeAgentSessionSelection } from "@research-assistant/workbench-sdk/agent-conversations";
import type { AgentMetadataGateway } from "@research-assistant/data/agent";
import { pendingBoundConversationId, readBoundCreation, reserveBoundConversation } from "@research-assistant/workbench-sdk/agent-conversations";
import { conversationCreationMessage } from "@research-assistant/workbench-sdk/agent-conversations";
import { notify } from "@research-assistant/workbench-sdk/feedback";

export interface WritingAgentHistoryAccess extends AgentConversationAccess {
  readonly metadata: AgentMetadataGateway;
  readonly selection: {
    readonly read: typeof readAgentSessionSelection;
    readonly write: typeof writeAgentSessionSelection;
    readonly clear: typeof clearAgentSessionSelection;
  };
}
const desktopSelection = { read: readAgentSessionSelection, write: writeAgentSessionSelection, clear: clearAgentSessionSelection };
export function useWritingAgentHistory(manuscriptId: string | undefined, access?: WritingAgentHistoryAccess, observe = true) {
  const identity = access?.identity ?? "desktop";
  const selection = access?.selection ?? desktopSelection;
  const [isOpen, setIsOpen] = useState(false);
  const [hasCurrentConversation, setHasCurrentConversation] = useState(false);
  const [selected, setSelected] = useState<{ identity: string; manuscriptId: string; id: string; pending?: true; target?: AgentMessageSearchTarget } | null>(() => {
    if (!manuscriptId) return null;
    const binding = { kind: "manuscript" as const, resourceId: manuscriptId };
    const id = selection.read(binding), pending = id ? null : pendingBoundConversationId(binding);
    return id ? { identity, manuscriptId, id } : pending ? { identity, manuscriptId, id: pending, pending: true } : null;
  });
  const selectionIdentity = useRef(identity);
  useLayoutEffect(() => {
    if (selectionIdentity.current !== identity) {
      selectionIdentity.current = identity;
      setSelected(null);
      return;
    }
    setSelected(previous => {
      if (previous?.identity === identity && previous.manuscriptId === manuscriptId) return previous;
      const binding = manuscriptId ? { kind: "manuscript" as const, resourceId: manuscriptId } : null;
      const id = binding ? selection.read(binding) : null, pending = binding && !id ? pendingBoundConversationId(binding) : null;
      return id && manuscriptId ? { identity, manuscriptId, id } : pending && manuscriptId ? { identity, manuscriptId, id: pending, pending: true } : null;
    });
  }, [identity, manuscriptId, selection]);
  const searchRequest = useRef(0);
  const [revealed, setRevealed] = useState<{ identity: string; manuscriptId: string; conversation: AgentConversationSummary } | null>(null);
  const [archiveState, setArchiveState] = useState<{ identity: string; manuscriptId: string; values: Readonly<Record<string, boolean>> } | null>(null);
  const selectedId = selected && selected.identity === identity && selected.manuscriptId === manuscriptId ? selected.id : null;
  const durableSelectedId = selected?.pending ? null : selectedId;
  const metadata = useConversationMetadata(durableSelectedId, manuscriptId ? { kind: "manuscript", resourceId: manuscriptId } : null, access?.metadata);
  const currentMetadata = useRef({ identity, selectedId: durableSelectedId, refresh: metadata.refresh });
  useLayoutEffect(() => { currentMetadata.current = { identity, selectedId: durableSelectedId, refresh: metadata.refresh }; }, [identity, durableSelectedId, metadata.refresh]);
  function refreshMetadata(): Promise<void> {
    if (currentMetadata.current.identity !== identity) return Promise.resolve();
    return currentMetadata.current.refresh();
  }
  const conversation = useAgentConversation(observe ? durableSelectedId : null, selected?.pending ? null : selected, access);
  const messages = useMemo(() => projectConversationMessages(conversation.projection), [conversation.projection]);
  useEffect(() => { setIsOpen(false); setHasCurrentConversation(false); }, [manuscriptId, identity]);
  useEffect(() => {
    if (isOpen) conversation.reconnect?.();
  }, [isOpen, conversation.reconnect]);
  function setOpen(open: boolean): void {
    setIsOpen(open);
    if (open) setHasCurrentConversation(true);
  }
  function setArchived(id: string, archived: boolean): void {
    if (currentMetadata.current.identity !== identity) return;
    if (manuscriptId) setArchiveState((previous) => ({ identity, manuscriptId, values: { ...(previous?.identity === identity && previous.manuscriptId === manuscriptId ? previous.values : {}), [id]: archived } }));
    // A menu mutation may finish after another conversation was selected in this host.
    if (id === currentMetadata.current.selectedId) void currentMetadata.current.refresh();
  }
  function select(id: string, archived = false, hit?: AgentSearchHit, pending = false, throughTurnId?: string): void {
    if (!manuscriptId || currentMetadata.current.identity !== identity) return;
    const target = throughTurnId ? { turnId: throughTurnId, requestId: ++searchRequest.current } : hit?.conversation.id === id && hit.itemId && hit.turnId
      ? { messageId: `${hit.turnId}/${hit.itemId}`, requestId: ++searchRequest.current } : undefined;
    setSelected({ identity, manuscriptId, id, ...(pending ? { pending: true as const } : {}), ...(target ? { target } : {}) });
    if (!pending) selection.write({ kind: "manuscript", resourceId: manuscriptId }, id);
    setArchived(id, archived);
    setOpen(true);
  }
  function newConversation(): void {
    if (!manuscriptId || currentMetadata.current.identity !== identity) return;
    let id: string;
    try {
      const binding = { kind: "manuscript" as const, resourceId: manuscriptId };
      if (durableSelectedId && readBoundCreation(binding)?.intent.id === durableSelectedId) {
        notify.error("当前创建恢复记录尚未清理，请先处理后再新建对话。"); return;
      }
      id = reserveBoundConversation(binding);
    }
    catch (cause: unknown) { notify.error(conversationCreationMessage(cause)); return; }
    if (durableSelectedId) selection.clear({ kind: "manuscript", resourceId: manuscriptId }, durableSelectedId);
    setRevealed(null);
    select(id, false, undefined, true);
  }
  function conversationCreated(conversation: AgentConversationSummary): void {
    if (!manuscriptId || selectedId !== conversation.id) return;
    selection.write({ kind: "manuscript", resourceId: manuscriptId }, conversation.id);
    if (currentMetadata.current.identity !== identity) return;
    setSelected({ identity, manuscriptId, id: conversation.id });
    setArchived(conversation.id, conversation.archived);
  }
  const isArchived = metadata.conversation?.archived ?? (archiveState?.identity === identity && archiveState.manuscriptId === manuscriptId && selectedId !== null && archiveState.values[selectedId] === true);
  const searchTarget = selectedId ? selected?.target ?? null : null;
  const revealedConversation = revealed?.identity === identity && revealed.manuscriptId === manuscriptId && revealed.conversation.id === selectedId ? revealed.conversation : null;
  function openRelatedConversation(related: AgentConversationSummary, throughTurnId?: string): void {
    if (!manuscriptId || currentMetadata.current.identity !== identity) return;
    select(related.id, related.archived, undefined, false, throughTurnId);
    setRevealed({ identity, manuscriptId, conversation: related });
  }
  function deleted(id: string): void {
    if (currentMetadata.current.identity !== identity || id !== currentMetadata.current.selectedId) return;
    selection.clear({ kind: "manuscript", resourceId: manuscriptId! }, id);
    setSelected(null); setRevealed(null); setIsOpen(false); setHasCurrentConversation(false);
  }
  return { isOpen, hasCurrentConversation, selectedId, pendingConversationId: selectedId !== null && selected?.pending ? selected.id : null, searchTarget, isArchived, metadata, refreshMetadata, messages, conversation, revealedConversation, openRelatedConversation, newConversation, setOpen, select, conversationCreated, setArchived, deleted };
}
