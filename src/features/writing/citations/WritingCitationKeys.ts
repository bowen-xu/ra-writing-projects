import { planCitationKeys } from "@research-assistant/writing";
import type { createExclusiveWritingGateway } from "../gateway/exclusiveWritingGateway";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { WritingCheckpointPersistence } from "../persistence/WritingCheckpointPersistence";
import type { WritingFileSaveQueue } from "../persistence/WritingFileSaveQueue";

/** Serializes name changes across all files of a manuscript, independently of chat. */
export class WritingCitationKeys {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly access: ReturnType<typeof createExclusiveWritingGateway>, private readonly sessions: WritingFileSessions,
    private readonly checkpoints: WritingCheckpointPersistence, private readonly saves: WritingFileSaveQueue,
    private readonly onBusy: (busy:boolean) => void = () => undefined) {}

  reconcile(id: string, pendingIds: readonly string[] = []): Promise<boolean> {
    const result = this.pending.catch(() => undefined).then(() => this.run(id,pendingIds));
    this.pending = result;
    return result;
  }

  private async run(id: string, pendingIds: readonly string[]): Promise<boolean> {
    if (this.access.isExclusive()) return false;
    const gateway = this.access.gateway;
    const all = await gateway.listBibliographyEntries(id,true);
    // Prove the identity plan from fresh metadata before loading source usage.
    // Distinct, persisted bare bases cannot change under any active subset:
    // live entries keep their base and inactive entries keep that same key.
    // Suffix families, legacy spelling and missing bases still need the full
    // preflight below, including the locked recheck after formal saves.
    const complete = planCitationKeys(all,new Set(all.map(row => row.id)));
    if (complete.every((row,index) => row.to === row.from && row.from === row.baseKey && row.baseKey === all[index]?.baseKey)) return false;
    const visible = await gateway.listBibliographyEntries(id);
    const active = new Set([...visible.map(row => row.id),...all.filter(row => row.libraryItem && pendingIds.includes(row.libraryItem.id)).map(row => row.id)]);
    let assignments = planCitationKeys(all,active);
    if (!assignments.some(row => row.from !== row.to || row.baseKey !== all.find(entry => entry.id === row.referenceId)?.baseKey)) return false;
    if (!all.length) return false;
    // Open headless sessions too: their review baselines and saves use exactly
    // the same checkpoint boundary as the visible editor.
    const unlock: (() => void)[] = [];
    let resumeSaves: (() => void) | undefined;
    let release: (() => void) | undefined;
    try {
      this.onBusy(true);
      for (const file of (await gateway.listFiles(id)).filter(file => file.kind === "tex")) {
        if (!this.sessions.get({manuscriptId:id,relativePath:file.relativePath})) {
          await this.checkpoints.open(id,await gateway.readFile(id,file.relativePath));
        }
      }
      for (const session of this.sessions.forManuscript(id)) unlock.push(session.lockCitationMigration());
      for (const session of this.sessions.forManuscript(id)) await this.saves.save(session.identity);
      resumeSaves = await this.saves.pause();
      await this.checkpoints.flushAll();
      release = await this.access.acquire();
      // Formal saves may have changed which automatic references are active.
      const [latest, used] = await Promise.all([this.access.source.listBibliographyEntries(id,true),this.access.source.listBibliographyEntries(id)]);
      const retained = new Set([...used.map(row => row.id),...latest.filter(row => row.libraryItem && pendingIds.includes(row.libraryItem.id)).map(row => row.id)]);
      assignments = planCitationKeys(latest,retained);
      const migration = await this.access.source.rekeyCitations(id,assignments).catch(() => this.access.source.rekeyCitations(id,assignments));
      this.checkpoints.acceptCitationMigration(migration);
      return assignments.some(row => row.from !== row.to || row.baseKey !== latest.find(entry => entry.id === row.referenceId)?.baseKey);
    } finally {
      release?.();
      for (const dispose of unlock.reverse()) dispose();
      resumeSaves?.();
      this.onBusy(false);
    }
  }
}
