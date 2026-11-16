import {useMemo, useState} from "react";
import {getReaderCloseCoordinator} from "@research-assistant/workbench-preview/document-close-coordinator";
import type {WritingDiffDemoStorage} from "../../../../agent/WritingDiffDemoStorage";
import type {WritingDiffDemoAgentStorage} from "./WritingDiffDemoAgentStorage";
import {createWritingDiffDemoGateway} from "./writingDiffDemoGateway";
import {useWritingDocuments} from "../../../../fixtures/useWritingDocuments";

/** Only mock I/O and the explicit simulated-process restart differ from Native. */
export function useWritingDiffDemoDocuments(storage: WritingDiffDemoStorage, manuscriptId: string, agent: WritingDiffDemoAgentStorage): ReturnType<typeof useWritingDocuments> & {restarting: boolean; restart(): Promise<boolean>} {
  const gateway = useMemo(() => createWritingDiffDemoGateway(storage, manuscriptId), [storage, manuscriptId]);
  const [restart, setRestart] = useState<{storage: WritingDiffDemoStorage; paths: readonly string[]; generation: number} | null>(null);
  const [restarting, setRestarting] = useState(false);
  const identity = useMemo(() => crypto.randomUUID(), [storage, restart?.generation]);
  const documents = useWritingDocuments({identity, manuscriptId, gateway, checkpointGateway: storage.checkpoints,
    agentGateways: agent.gateways, admissionsBlocked: restarting,
    initialOpenPaths: restart?.storage === storage ? restart.paths : storage.initialOpenPaths});
  return {...documents, restarting, restart: async (): Promise<boolean> => {
    if (restarting || !documents.ready) return false;
    setRestarting(true);
    try {
      if (!await documents.prepareClose()) return false;
      if (!await getReaderCloseCoordinator().prepareAll()) return false;
      agent.recoverOnStartup();
      setRestart(previous => ({storage, paths: documents.openPaths, generation: (previous?.generation ?? 0) + 1}));
      return true;
    } finally {setRestarting(false);}
  }};
}
