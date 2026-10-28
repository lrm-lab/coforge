import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills } from "#src/code-agent/agent-skills";

// macOS tmpdir lives under /var, a symlink; listAgentSkills rejects linked roots.
const tempRoot = realpathSync(tmpdir());

/** Skill-root variables a host may export, cleared so this scan sees only HOME. */
const NO_HOST_ROOTS = {
  CLAUDE_CONFIG_DIR: "",
  CODEX_HOME: "",
  KIRO_HOME: "",
  XDG_CONFIG_HOME: "",
  GROK_HOME: "",
  PI_CODING_AGENT_DIR: "",
};

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nprivate`;

test("Devin Skills scan its documented project and user roots, including CoForge's .agents layout", async () => {
  const root = await mkdtemp(join(tempRoot, "devin-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home");
  try {
    await Bun.write(join(cwd, ".agents/skills/assigned/SKILL.md"), skill("assigned"));
    await Bun.write(join(cwd, ".devin/skills/native/SKILL.md"), skill("native"));
    await Bun.write(join(home, ".config/devin/skills/personal/SKILL.md"), skill("personal"));
    await Bun.write(join(home, ".agents/skills/shared/SKILL.md"), skill("shared"));

    const result = await listAgentSkills({
      provider: "devin",
      agentWorkspaceDirectory: cwd,
      environment: { ...NO_HOST_ROOTS, HOME: home },
    });

    expect(result.workspace.entries.map((entry) => entry.name).sort()).toEqual([
      "assigned",
      "native",
    ]);
    expect(result.global.entries.map((entry) => entry.name).sort()).toEqual(["personal", "shared"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
