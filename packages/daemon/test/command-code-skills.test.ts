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

const rootSkill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nprivate`;
const found = (scope: { entries: readonly { name: string; sourcePath: string }[] }) =>
  scope.entries.map((entry) => [entry.name, entry.sourcePath]);

test("Command Code Skills scan the native root and the agents compat root", async () => {
  const root = await mkdtemp(join(tempRoot, "command-code-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home");
  try {
    for (const [dir, name] of [
      [".commandcode/skills", "local-commandcode"],
      [".agents/skills", "local-agents"],
      [".cursor/skills", "must-not-scan"],
      [".grok/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(cwd, dir, name, "SKILL.md"), rootSkill(name));
    for (const [dir, name] of [
      [".commandcode/skills", "global-commandcode"],
      [".agents/skills", "global-agents"],
      [".cursor/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(home, dir, name, "SKILL.md"), rootSkill(name));

    const result = await listAgentSkills({
      provider: "command-code",
      agentWorkspaceDirectory: cwd,
      environment: { ...NO_HOST_ROOTS, HOME: home },
    });
    expect(found(result.workspace)).toEqual([
      ["local-agents", ".agents/skills"],
      ["local-commandcode", ".commandcode/skills"],
    ]);
    expect(found(result.global)).toEqual([
      ["global-agents", "~/.agents/skills"],
      ["global-commandcode", "~/.commandcode/skills"],
    ]);
    expect(result.workspace.entries[0]).toMatchObject({
      displayName: "local-agents",
      description: "local-agents skill",
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("private");

    const homeless = await listAgentSkills({
      provider: "command-code",
      agentWorkspaceDirectory: cwd,
      environment: { ...NO_HOST_ROOTS, HOME: "" },
    });
    expect(homeless.global).toEqual({ status: "unsupported", entries: [], directories: [] });
    expect(found(homeless.workspace)).toEqual([
      ["local-agents", ".agents/skills"],
      ["local-commandcode", ".commandcode/skills"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
