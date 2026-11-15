import {createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from "react";
import {WritingFileSessions} from "../editor/writingFileSessions";
import {getWritingGateway} from "../gateway";
import {createExclusiveWritingGateway} from "../gateway/exclusiveWritingGateway";
import {useWritingDocumentPersistence} from "./useWritingDocumentPersistence";
import {WritingFileRuntimeStore, type WritingFileApplicationHost} from "./WritingFileRuntimeStore";
import {useWritingFileApplications} from "../agent/useWritingFileApplications";
import type {WritingPersistenceControl} from "../useWritingPersistence";
import {notify} from "@research-assistant/workbench-sdk/feedback";
import {errorMessage} from "../workspaceState";
import {useWritingCloseBoundary} from "./useWritingCloseBoundary";
import {getRuntimeEnvironment, getNativePreviewCapabilities} from "@research-assistant/workbench-sdk/environment";
import { agentProposalGateway, agentWorkspaceReviewGateway, agentWritingFileDeliveryGateway, agentPendingWritingApplicationGateway, agentPendingWritingUndoGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import { agentSessionGateway } from "@research-assistant/workbench-sdk/agent-gateways";
import {desktopWritingApplicationGateways} from "../agent/useWritingProposalApplication";
import type {PluginWritingRuntimeBinding, PluginWritingRuntimeProps} from "@research-assistant/workbench-sdk/activation";
import {hasPendingWritingSubmissions} from "@research-assistant/workbench-sdk/agent-writing";
import {useAgentQueueOwners, useAgentSteeringOwners} from "@research-assistant/workbench-sdk/agent-submission";
import {WritingRuntimeAdmissionScope, writingRuntimeAdmission} from "./writingRuntimeAdmission";
import {hasPendingWritingCompactions} from "../agent/writingCompactionController";

const Context = createContext<WritingFileRuntimeStore | null>(null);
export function useOptionalWritingFileRuntime(): WritingFileRuntimeStore | null {return useContext(Context);}
export function useWritingFileRuntime(): WritingFileRuntimeStore {
  const owner = useContext(Context);
  if (!owner) throw new Error("WRITING_FILE_RUNTIME_UNAVAILABLE");
  return owner;
}
export function WritingFileRuntimeProvider({children, runtime}: {
  readonly children: ReactNode;
  readonly runtime?: PluginWritingRuntimeProps;
}): React.JSX.Element {
  const [files] = useState(() => new WritingFileSessions());
  const [access] = useState(() => createExclusiveWritingGateway(getWritingGateway()));
  const {checkpoints, saves} = useWritingDocumentPersistence(files, access.gateway);
  const owner = useMemo(() => new WritingFileRuntimeStore(files, access, checkpoints, saves), [files, access, checkpoints, saves]);
  const queues = useAgentQueueOwners(), steering = useAgentSteeringOwners();
  const admission = useMemo(() => writingRuntimeAdmission(runtime && {
    isDisabled: runtime.isDisabled, subscribe: runtime.subscribe,
  }), [runtime?.isDisabled, runtime?.subscribe]);
  const binding = useMemo<PluginWritingRuntimeBinding>(() => {
    function Scope({children}: {readonly children: ReactNode}): React.JSX.Element {
      return <Context.Provider value={owner}>
        <WritingRuntimeAdmissionScope value={admission}>{children}</WritingRuntimeAdmissionScope>
      </Context.Provider>;
    }
    const pending = () => owner.access.isExclusive() || owner.hasPendingDeliveries() || hasPendingWritingSubmissions() || hasPendingWritingCompactions()
      || queues?.writing.hasPending() === true || steering?.writing.hasPending() === true
      || steering?.handoffs.hasPending("manuscript") === true;
    return {Scope, prepareClose: async () => {
      if (pending()) return false;
      await owner.flushDeliveries();
      return !pending();
    }};
  }, [owner, admission, queues, steering]);
  useWritingCloseBoundary({activePath: undefined, saveCurrent: async () => (await saves.flushAll()).length === 0,
    persistCurrent: {}, fileSaves: saves, checkpoints,
    ...(runtime ? {onRegistered: () => runtime.onReady(binding)} : {}),
    prepareFileTasks: async () => {await owner.flushDeliveries(); return !owner.access.isExclusive();}});
  const projects = useSyncExternalStore(owner.subscribe, owner.getProjects);
  return <Context.Provider value={owner}><WritingRuntimeAdmissionScope value={admission}>
    {children}{projects.map(id => <WritingProjectRuntime key={id} id={id} owner={owner}/>)}
  </WritingRuntimeAdmissionScope></Context.Provider>;
}

const WritingProjectRuntime = memo(function WritingProjectRuntime({id, owner}: {readonly id: string; readonly owner: WritingFileRuntimeStore}) {
  const metadata = useSyncExternalStore(owner.subscribe, () => owner.getMetadata(id));
  useSyncExternalStore(owner.subscribe, () => owner.getHostVersion(id));
  const host = owner.readHost(id), gateway = owner.access.gateway;
  // Browser mocks have no native tool-event transport. Their real mock journals
  // and injected gateways still own discovery, delivery and recovery.
  const [agentGateways] = useState(() => {
    const runtime = getRuntimeEnvironment();
    return runtime.mode === "preview" && getNativePreviewCapabilities(runtime) === undefined ? {
      application: desktopWritingApplicationGateways, pendingApplications: agentPendingWritingApplicationGateway,
      pendingUndos: agentPendingWritingUndoGateway,
      delivery: {sessions: agentSessionGateway, proposals: agentProposalGateway, reviews: agentWorkspaceReviewGateway, deliveries: agentWritingFileDeliveryGateway},
    } : undefined;
  });
  const attempt = useSyncExternalStore(owner.subscribe, () => owner.getAttempt(id));
  const failed = useSyncExternalStore(owner.subscribe, () => owner.getFailure(id));
  const [loadedAttempt, setLoadedAttempt] = useState(-1);
  useEffect(() => {
    let current = true;
    void Promise.all([gateway.listFiles(id), gateway.listDirectories(id), gateway.listCitationBindings(id), gateway.getBibliographyStatus(id), gateway.listManuscripts()])
      .then(([files, directories, citations, bibliography, manuscripts]) => {
        if (!manuscripts.some(item => item.id === id && item.status === "active")) throw new Error("MANUSCRIPT_UNAVAILABLE：写作项目不可用，请核对项目状态。");
        if (current) {owner.setMetadata(id, {files, directories, citations, bibliography, manuscripts}); setLoadedAttempt(attempt);}
      }).catch(reason => {if (current) {const message = `无法准备写作文件会话：${errorMessage(reason)}`; owner.fail(id, message); notify.error(message);}});
    return () => {current = false;};
  }, [id, owner, gateway, attempt]);
  const persistence = useMemo<WritingPersistenceControl>(() => Object.assign(async () => (await owner.saves.flushAll()).length === 0, {
    pause: async () => Object.assign(await owner.saves.pause(), {readSnapshot: () => undefined}),
  }), [owner]);
  const ready = loadedAttempt === attempt && !failed && metadata !== null && metadata.manuscripts.some(item => item.id === id && item.status === "active") && (host?.ready ?? true);
  const applications = useWritingFileApplications({access: owner.access, files: owner.files, checkpoints: owner.checkpoints, manuscriptId: id,
    ...(agentGateways ? {agentGateways} : {}),
    ready, persistence: host?.persistence ?? persistence, fileSaves: owner.saves,
    ...(host?.admissionsBlocked === undefined ? {} : {admissionsBlocked: host.admissionsBlocked}),
    readHost: () => owner.readHost(id)?.readHost() ?? {manuscriptId: id, activePath: undefined, port: null, ready},
    onFileConflict: conflict => {
      const current = owner.readHost(id);
      if (current) current.onFileConflict(conflict);
      else notify.error(`文件存在外部修改，已保留当前内容：${conflict.relativePath}`);
    },
    onBusyChange: busy => owner.readHost(id)?.onBusyChange?.(busy),
    publishMetadata: value => owner.setMetadata(id, value),
  });
  useLayoutEffect(() => {owner.setApplications(id, applications);});
  return host ? null : <>{applications.recoveryFeedback}</>;
});

export function useWritingProjectFiles(id: string | undefined) {
  const owner = useOptionalWritingFileRuntime();
  useEffect(() => {if (id) owner?.activate(id);}, [id, owner]);
  return useSyncExternalStore(owner?.subscribe ?? noSubscription, () => owner?.getApplications(id) ?? null);
}
const noSubscription = (): (() => void) => () => undefined;

/** The visible editor supplies interaction gates, never ownership of file work. */
export function useWritingFileApplicationHost(id: string | undefined, options: WritingFileApplicationHost): void {
  const owner = useOptionalWritingFileRuntime(), current = useRef(options); current.current = options;
  const [token] = useState(() => ({}));
  useLayoutEffect(() => id ? owner?.attach(id, token, () => current.current) : undefined, [id, owner, token]);
  const snapshot = options.readHost();
  useLayoutEffect(() => {if (id) owner?.refreshHost(id, token);}, [id, owner, token, options.ready, snapshot.ready, snapshot.activePath, snapshot.port]);
}
