import { foldUntrustedLine } from "../../internal";
import {
  COMMUNICATION_STYLE,
  renderCoforgeCliGuide,
  sanitizeQuotedName,
  stripHeadingMarkers,
} from "./cli-guide";
import type { GuideFeatures } from "./types";

export type ExternalAgentGuideInput = {
  agent: {
    id: string;
    name: string;
    displayName: string;
    description: string;
    role: string;
  };
  workspace: {
    id: string;
    slug: string;
    name: string;
  };
  features?: GuideFeatures;
};

export function buildExternalAgentGuide(input: ExternalAgentGuideInput): string {
  const { agent, workspace, features } = input;
  const rawName = agent.displayName || agent.name;
  const who = rawName
    ? `You are "${sanitizeQuotedName(rawName)}", an external AI agent in CoForge.`
    : "You are an external AI agent in CoForge.";

  const contextLines = ["## Current Runtime Context", ""];
  const description = agent.description.trim();
  if (description)
    contextLines.push(`- Role: ${foldUntrustedLine(stripHeadingMarkers(description))}`);
  if (agent.name) contextLines.push(`- Username: @${foldUntrustedLine(agent.name)}`);
  contextLines.push(`- Agent ID: ${agent.id}`);
  const wsName = foldUntrustedLine(workspace.name);
  contextLines.push(`- Workspace: ${wsName ? `${wsName} (${workspace.slug})` : workspace.slug}`);
  contextLines.push("- Mode: external (no Computer or daemon)");

  const setup = `## External Agent CLI
- Always pass \`--profile <slug>\` or set \`COFORGE_PROFILE=<slug>\` (default profile: \`${workspace.slug}-${agent.name}\`).
- Pull messages with \`coforge message check\` (server inbox cursor; no daemon or App items).
- Scheduled reminders (\`coforge reminder schedule|update|snooze\`) are unavailable to external Agents (\`reminders_unsupported_for_external_agents\`); use your own runtime's scheduler and state in the thread when you will follow up.
- Daemon-local commands (\`coforge context search|read\`, \`coforge proc\`, GitHub credential helpers, \`--send-draft\`) are unavailable.`;

  const standingSections = [
    COMMUNICATION_STYLE,
    ...renderCoforgeCliGuide({ audience: "external", ...(features ? { features } : {}) }),
  ].join("\n\n");

  return [who, contextLines.join("\n"), setup, standingSections].join("\n\n");
}
