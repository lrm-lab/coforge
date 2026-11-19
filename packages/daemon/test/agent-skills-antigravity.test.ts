import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills } from "#src/code-agent/agent-skills";

const tempRoot = realpathSync(tmpdir());

test("Antigravity global skills honor GEMINI_HOME when set and still skip antigravity-cli/skills", async () => {
  const root = await mkdtemp(join(tempRoot, "antigravity-gemini-home-skills-"));
  const cwd = join(root, "agent");
  const home = join(root, "home");
  const geminiHome = join(root, "custom-gemini");
  try {
    const skill = "---\nname: agy-custom\ndescription: Custom GEMINI_HOME skill\n---\nprivate";
    await Bun.write(join(geminiHome, "config/skills/custom/SKILL.md"), skill);
    await Bun.write(join(geminiHome, "antigravity-cli/skills/must-not-scan/SKILL.md"), skill);
    await Bun.write(join(home, ".gemini/config/skills/default-home/SKILL.md"), skill);

    const result = await listAgentSkills({
      provider: "antigravity",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home, GEMINI_HOME: geminiHome },
    });

    expect(result.global.entries).toEqual([
      {
        name: "custom",
        displayName: "agy-custom",
        description: "Custom GEMINI_HOME skill",
        userInvocable: false,
        sourcePath: "$GEMINI_HOME/config/skills",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
