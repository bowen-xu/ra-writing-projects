export interface WritingDiffResolution {
  readonly before: string;
  readonly after: string;
  readonly action: "keep" | "undo";
}

export interface WritingDiffControls {
  /** The shared editor owns the transaction and history when provided. */
  readonly onResolveChange?: (resolution: WritingDiffResolution) => void;
}
