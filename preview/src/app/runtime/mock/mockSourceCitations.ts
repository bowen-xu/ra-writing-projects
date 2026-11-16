import { agentFileSourceLink, type AgentUserInput } from "@research-assistant/core/agent";

/** Mock response data exercises the production Markdown/navigation path. */
export function mockSourceCitations(inputs: readonly AgentUserInput[]): string {
  return inputs.flatMap(input => {
    if (input.type !== "mention" || input.target.kind !== "file") return [];
    const href = agentFileSourceLink(input);
    if (!href) return [];
    const label = input.name.replace(/[\\[\]]/gu, character => `\\${character}`);
    return [`[${label}](${href})`];
  }).join(" · ");
}
