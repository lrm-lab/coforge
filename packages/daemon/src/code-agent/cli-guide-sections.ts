import {
  cloudComputerAgentSkillsDirectory,
  cloudComputerSharedSkillsDirectory,
  isCloudComputerSkillsEnabled,
} from "@coforge/agent/cloud-computer-skills";
import {
  buildCoforgeCliGuideSections as buildSharedCliGuideSections,
  CLI_CHANNEL_MESSAGE_EXAMPLE,
  type CloudComputerSkillsCapability,
} from "@lrm/coforge-sdk/agent";
import type { CoforgeAgentPromptContext } from "./agent-instructions";

export { CLI_CHANNEL_MESSAGE_EXAMPLE };

export type CoforgeCliGuideOptions = Pick<
  CoforgeAgentPromptContext,
  "extraCriticalRules" | "capabilities" | "agentId" | "environment"
> & {
  features?: NonNullable<CoforgeAgentPromptContext["identity"]>["features"];
};

function cloudComputerSkillsCapability(
  agentId: string | undefined,
  environment?: Readonly<Record<string, string | undefined>>,
): CloudComputerSkillsCapability | undefined {
  if (!environment || !isCloudComputerSkillsEnabled(environment)) return undefined;
  const sharedDirectory = cloudComputerSharedSkillsDirectory(environment);
  const agentDirectory = agentId
    ? cloudComputerAgentSkillsDirectory(agentId, environment)
    : `${sharedDirectory.replace(/\/skills$/, "")}/agent-skills/<agentId>`;
  return { sharedDirectory, agentDirectory };
}

export function buildCoforgeCliGuideSections(options: CoforgeCliGuideOptions = {}) {
  const cloudSkills = cloudComputerSkillsCapability(options.agentId, options.environment);
  const capabilities =
    options.capabilities || cloudSkills
      ? { ...options.capabilities, ...(cloudSkills ? { cloudSkills } : {}) }
      : undefined;
  return buildSharedCliGuideSections({
    audience: "managed",
    ...(options.features ? { features: options.features } : {}),
    extraCriticalRules: options.extraCriticalRules,
    ...(capabilities ? { capabilities } : {}),
  });
}
