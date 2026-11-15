export type SaveState = "saved" | "dirty" | "saving" | "error";

export function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "object" && reason !== null && !Array.isArray(reason)) {
    const message = (reason as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return String(reason);
}

export function errorCode(reason: unknown): string | undefined {
  if (typeof reason !== "object" || reason === null || Array.isArray(reason)) return undefined;
  const code = (reason as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

export function readCursorOffsets(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

export function readAutoCompile(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).autoCompile === true;
}
