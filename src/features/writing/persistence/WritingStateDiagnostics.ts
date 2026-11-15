import type { WritingDocumentIdentity, WritingDocumentSnapshot } from "@research-assistant/writing";

export type WritingDiagnosticPhase = "install" | "recovery" | "checkpoint" | "save-intent" | "formal-save" | "draft-clear";
export type WritingDiagnosticSource = "disk-open" | "checkpoint-restore" | "input" | "agent" | "review" | "undo" | "redo" | "disk-reload"
  | "disk-match" | "intent-written" | "intent-not-written" | "disk-conflict" | "checkpoint-queue" | "save-queue"
  | "save-complete" | "conflict-reload" | "conflict-copy" | "discard-recovery" | "delete-file";
interface SnapshotMetadata { readonly version: number; readonly contentSha256: string; readonly baselineSha256: string }
export interface WritingDiagnosticEvent extends WritingDocumentIdentity {
  readonly ownerId: string;
  readonly sequence: number;
  readonly skipped: number;
  readonly operationId: string;
  readonly phase: WritingDiagnosticPhase;
  readonly source: WritingDiagnosticSource;
  readonly status: "started" | "completed" | "failed" | "conflict";
  readonly before: SnapshotMetadata | null;
  readonly after: SnapshotMetadata | null;
  readonly savedVersion: number | null;
  readonly savedSha256: string | null;
  readonly expectedSha256: string | null;
  readonly targetSha256: string | null;
}
export interface WritingDiagnosticInput extends WritingDocumentIdentity {
  readonly operationId?: string;
  readonly phase: WritingDiagnosticPhase;
  readonly source: WritingDiagnosticSource;
  readonly status: WritingDiagnosticEvent["status"];
  readonly before?: WritingDocumentSnapshot;
  readonly after?: WritingDocumentSnapshot;
  readonly savedVersion?: number;
  readonly savedSha256?: string;
  readonly expectedSha256?: string;
  readonly targetSha256?: string;
}
type Sink = (event: WritingDiagnosticEvent) => void | Promise<void>;
async function hashText(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Opt-in observation only. Neither its failures nor its replies authorize file operations. */
export class WritingStateDiagnostics {
  private sequence = 0;
  private skipped = 0;
  private ownerId: string | undefined;
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly sink?: Sink, private readonly hash = hashText) {}
  get enabled(): boolean { return this.sink !== undefined; }

  record(input: WritingDiagnosticInput): string | undefined {
    if (!this.sink) return;
    // A slow sink cannot retain an unbounded number of manuscript snapshots.
    const sequence = ++this.sequence;
    if (this.pending.size >= 32) { this.skipped += 1; return; }
    try {
      this.ownerId ??= crypto.randomUUID();
      const ownerId = this.ownerId, skipped = this.skipped;
      this.skipped = 0;
      const operationId = input.operationId ?? `${ownerId}:${sequence}`;
      const fields = { ownerId, sequence, skipped, operationId, manuscriptId: input.manuscriptId,
        relativePath: input.relativePath, phase: input.phase, source: input.source, status: input.status,
        savedVersion: input.savedVersion ?? null, savedSha256: input.savedSha256 ?? null,
        expectedSha256: input.expectedSha256 ?? null, targetSha256: input.targetSha256 ?? null };
      const metadata = async (snapshot?: WritingDocumentSnapshot): Promise<SnapshotMetadata | null> => {
        if (!snapshot) return null;
        const version = snapshot.version;
        const [contentSha256, baselineSha256] = await Promise.all([this.hash(snapshot.content), this.hash(snapshot.reviewBaseline)]);
        return { version, contentSha256, baselineSha256 };
      };
      // Construct a closed payload; never spread input, snapshots, receipts or exceptions.
      const task = Promise.all([metadata(input.before), metadata(input.after)]).then(async ([before, after]) => {
        await this.sink!({ ...fields, before, after });
      }).catch(() => { this.skipped += 1; });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
      return operationId;
    } catch { this.skipped += 1; /* Diagnostic setup never enters the file operation's failure boundary. */ }
  }

  /** Diagnostic consumers may await captured observations; production writes never do. */
  async drain(): Promise<void> { await Promise.all([...this.pending]); }
}

export function configuredWritingDiagnostics(): WritingStateDiagnostics {
  return new WritingStateDiagnostics(import.meta.env?.VITE_WRITING_STATE_TRACE === "1"
    ? event => console.debug("[writing-state]", event) : undefined);
}
