import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills } from "#src/code-agent/agent-skills";

const tempRoot = realpathSync(tmpdir());

const NO_HOST_ROOTS = {
  CLAUDE_CONFIG_DIR: "",
  CODEX_HOME: "",
  KIRO_HOME: "",
  XDG_CONFIG_HOME: "",
  GROK_HOME: "",
  PI_CODING_AGENT_DIR: "",
};

function rootSkill(name: string) {
  return `---\nname: ${name}\ndescription: ${name}\n---\n`;
}

function found(scope: { entries: Array<{ name: string; sourcePath: string }> }) {
  return scope.entries.map((entry) => [entry.name, entry.sourcePath] as const);
}

test("cloud-computer gate adds persistent skill roots without changing the off path", async () => {
  const root = await mkdtemp(join(tempRoot, "coforge-cloud-skills-"));
  const cwd = join(root, "agent");
  const workspace = join(root, "workspace");
  try {
    await Bun.write(join(cwd, ".agents/skills/local/SKILL.md"), rootSkill("local"));
    await Bun.write(join(workspace, "skills", "shared/SKILL.md"), rootSkill("shared"));
    await Bun.write(join(workspace, "agent-skills", "agent-1", "mine/SKILL.md"), rootSkill("mine"));

    const off = await listAgentSkills({
      provider: "coforge",
      agentId: "agent-1",
      agentWorkspaceDirectory: cwd,
      environment: { ...NO_HOST_ROOTS, HOME: root, COFORGE_CLOUD_COMPUTER: "0" },
    });
    expect(
      found(off.workspace)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["local"]);

    const on = await listAgentSkills({
      provider: "coforge",
      agentId: "agent-1",
      agentWorkspaceDirectory: cwd,
      environment: {
        ...NO_HOST_ROOTS,
        HOME: root,
        COFORGE_CLOUD_COMPUTER: "1",
        WORKSPACE: workspace,
      },
    });
    expect(
      found(on.workspace)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["local", "mine", "shared"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
