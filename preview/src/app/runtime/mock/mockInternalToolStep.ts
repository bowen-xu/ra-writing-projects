/** Mock tool I/O projected through the existing durable Agent event protocol. */
export interface MockInternalToolStep {
  readonly name: string;
  readonly arguments: unknown;
  readonly output: unknown;
  readonly isError?: boolean;
}
export interface MockInternalTurnResult {
  readonly steps: readonly MockInternalToolStep[];
  readonly outcome?: "completed" | "failed" | "canceled";
}
