export interface CompilePreferences {
  readonly draft: boolean;
  readonly codeCheck: boolean;
  readonly stopOnFirstError: boolean;
}
export function readCompilePreferences(value: unknown): CompilePreferences {
  const options = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyCodeCheck = options.checkSyntax;
  return {
    draft: options.draft === true,
    codeCheck: options.codeCheck === undefined ? legacyCodeCheck !== false : options.codeCheck !== false,
    stopOnFirstError: options.stopOnFirstError === true,
  };
}
