import type {WritingFileSessions} from "../editor/writingFileSessions";
import type {createExclusiveWritingGateway} from "../gateway/exclusiveWritingGateway";
import type {WritingCheckpointPersistence} from "./WritingCheckpointPersistence";
import type {WritingFileSaveQueue} from "./WritingFileSaveQueue";
import type {useWritingFileApplications} from "../agent/useWritingFileApplications";
import type {WritingApplicationMetadata} from "../agent/useWritingProposalApplication";

export type WritingFileApplications = ReturnType<typeof useWritingFileApplications>;
export type WritingFileApplicationHost = Omit<Parameters<typeof useWritingFileApplications>[0], "access" | "files" | "checkpoints" | "manuscriptId">;

/** Application lifetime; mounting a chat or editor never creates another file owner. */
export class WritingFileRuntimeStore {
  private projects: readonly string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly hosts = new Map<string, {token: object; read: () => WritingFileApplicationHost; version: number}>();
  private readonly applications = new Map<string, WritingFileApplications>();
  private readonly metadata = new Map<string, WritingApplicationMetadata>();
  private readonly failures = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  constructor(readonly files: WritingFileSessions, readonly access: ReturnType<typeof createExclusiveWritingGateway>,
    readonly checkpoints: WritingCheckpointPersistence, readonly saves: WritingFileSaveQueue) {}
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private publish(): void {for (const listener of this.listeners) listener();}
  getProjects = (): readonly string[] => this.projects;
  activate(id: string): void {
    if (this.projects.includes(id)) return;
    this.projects = [...this.projects, id]; this.publish();
  }
  getHostVersion(id: string): number {return this.hosts.get(id)?.version ?? 0;}
  readHost(id: string): WritingFileApplicationHost | undefined {return this.hosts.get(id)?.read();}
  attach(id: string, token: object, read: () => WritingFileApplicationHost): () => void {
    const prior = this.hosts.get(id);
    this.hosts.set(id, {token, read, version: (prior?.version ?? 0) + 1}); this.activate(id); this.publish();
    return () => {if (this.hosts.get(id)?.token === token) {this.hosts.delete(id); this.publish();}};
  }
  refreshHost(id: string, token: object): void {
    const host = this.hosts.get(id);
    if (host?.token !== token) return;
    host.version++; this.publish();
  }
  getApplications(id: string | undefined): WritingFileApplications | null {return id ? this.applications.get(id) ?? null : null;}
  setApplications(id: string, value: WritingFileApplications): void {this.applications.set(id, value); this.publish();}
  hasPendingDeliveries(): boolean {return this.projects.some(id => {
    const applications = this.applications.get(id);
    return !applications || applications.agentDelivery.hasPending();
  });}
  async flushDeliveries(): Promise<void> {for (const value of this.applications.values()) await value.agentDelivery.flush();}
  getMetadata(id: string): WritingApplicationMetadata | null {return this.metadata.get(id) ?? null;}
  getFailure(id: string): string | null {return this.failures.get(id) ?? null;}
  getAttempt(id: string): number {return this.attempts.get(id) ?? 0;}
  fail(id: string, message: string): void {this.failures.set(id, message); this.publish();}
  retry(id: string): void {this.failures.delete(id); this.attempts.set(id, this.getAttempt(id) + 1); this.publish();}
  setMetadata(id: string, value: WritingApplicationMetadata): void {
    this.metadata.set(id, value); this.readHost(id)?.publishMetadata(value); this.publish();
  }
}
