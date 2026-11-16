/** A preview-only I/O pause that can be continued manually or after a delay. */
export class WritingDemoTimedGate {
  private readonly continued: Promise<void>;
  private resume: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting = false;

  constructor(private durationMs: number | undefined) {
    this.continued = new Promise(resolve => { this.resume = resolve; });
  }

  wait(): Promise<void> {
    if (!this.waiting && this.resume) {
      this.waiting = true;
      this.schedule();
    }
    return this.continued;
  }

  setDuration(durationMs: number): void {
    if (this.durationMs === undefined || this.durationMs === durationMs || !this.resume) return;
    this.durationMs = durationMs;
    if (this.waiting) this.schedule();
  }

  release(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const resume = this.resume;
    this.resume = undefined;
    resume?.();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.durationMs !== undefined) this.timer = setTimeout(() => this.release(), this.durationMs);
  }
}
