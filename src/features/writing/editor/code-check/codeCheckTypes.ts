export interface CodeCheckError {
  readonly startPos: number;
  readonly endPos: number;
  readonly pos: number;
  readonly suppressIfEditing?: boolean;
  readonly type: "info" | "warning" | "error";
  readonly text: string;
}

export interface CodeCheckResult {
  readonly errors: readonly CodeCheckError[];
  readonly requestId: number;
}
