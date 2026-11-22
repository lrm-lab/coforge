import {
  cloudComputerAgentSkillsDirectory,
  cloudComputerSharedSkillsDirectory,
  isCloudComputerSkillsEnabled,
} from "@coforge/agent/cloud-computer-skills";
import {
  buildCoforgeCliGuideSections as buildSharedCliGuideSections,
  CLI_CHANNEL_MESSAGE_EXAMPLE,
} from "@lrm/coforge-sdk/agent";
import type { CoforgeAgentPromptContext } from "./agent-instructions";

export { CLI_CHANNEL_MESSAGE_EXAMPLE };

export type CoforgeCliGuideOptions = Pick<
  CoforgeAgentPromptContext,
  "extraCriticalRules" | "capabilities" | "agentId" | "environment"
> & {
  features?: NonNullable<CoforgeAgentPromptContext["identity"]>["features"];
};

function cloudComputerSkillsGuidance(
  agentId: string | undefined,
  environment?: Readonly<Record<string, string | undefined>>,
): string {
  if (!environment || !isCloudComputerSkillsEnabled(environment)) return "";
  const shared = cloudComputerSharedSkillsDirectory(environment);
  const agentDir = agentId
    ? cloudComputerAgentSkillsDirectory(agentId, environment)
    : `${shared.replace(/\/skills$/, "")}/agent-skills/<agentId>`;
  return `Persistent skills on this cloud computer: write shared skills under \`${shared}/<name>/SKILL.md\`, and this Agent's skills under \`${agentDir}/<name>/SKILL.md\`. Do not rely on \`/root/.pi/agent/skills\` or only \`.pi/skills\` under the Agent workspace — those are not the durable copies. Delete by removing the directory under those persistent paths.\n`;
}

export function buildCoforgeCliGuideSections(options: CoforgeCliGuideOptions = {}) {
  return buildSharedCliGuideSections({
    audience: "managed",
    ...(options.features ? { features: options.features } : {}),
    extraCriticalRules: options.extraCriticalRules,
    capabilities: options.capabilities,
    cloudSkillsGuidance: cloudComputerSkillsGuidance(options.agentId, options.environment),
  });
}
