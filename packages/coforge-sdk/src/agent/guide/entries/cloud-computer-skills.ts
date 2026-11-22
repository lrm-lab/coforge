import type { FeatureGuideEntry } from "../types";

export const CLOUD_COMPUTER_SKILLS_GUIDE_ENTRY: FeatureGuideEntry = {
  id: "cloudComputerSkills",
  manualTopics: [],
  audience: "managed",
  isEnabled: ({ capabilities }) => Boolean(capabilities?.cloudSkills),
  render: ({ capabilities }) => {
    const skills = capabilities?.cloudSkills;
    if (!skills) return "";
    return `## Cloud computer skills\nPersistent skills on this cloud computer: write shared skills under \`${skills.sharedDirectory}/<name>/SKILL.md\`, and this Agent's skills under \`${skills.agentDirectory}/<name>/SKILL.md\`. Do not rely on \`/root/.pi/agent/skills\` or only \`.pi/skills\` under the Agent workspace — those are not the durable copies. Delete by removing the directory under those persistent paths.`;
  },
};
