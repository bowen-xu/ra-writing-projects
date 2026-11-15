import type { AgentCompileResult } from "@research-assistant/core/agent";
import type { PdfSource } from "@research-assistant/core/pdf-view";
import type { AgentCompileResultGateway } from "@research-assistant/data/agent";

/**
 * Converts an identity-checked Agent compile artifact into the shared PDF View
 * input. The result ID is part of the document key so an expired or newer
 * compile cannot reuse an old PDF viewer session.
 */
export async function readAgentCompilePdfSource(
  gateway: AgentCompileResultGateway,
  result: AgentCompileResult,
): Promise<PdfSource> {
  const bytes = await gateway.readPdf(result);
  return {
    key: `${result.identity.manuscriptId}:agent-compile:${result.resultId}`,
    revision: result.compileVersion,
    bytes,
  };
}
