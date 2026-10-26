import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills } from "#src/code-agent/agent-skills";

const tempRoot = realpathSync(tmpdir());

test("DSH skill metadata observes project roots and explicit DSH home overrides", async () => {
  const root = await mkdtemp(join(tempRoot, "coforge-dsh-skills-"));
  const cwd = join(root, "agent");
  const dshHome = join(root, "dsh-home");
  const agentsHome = join(root, "agents-home");
  try {
    for (const [directory, name] of [
      [join(cwd, ".agents/skills"), "assigned"],
      [join(cwd, ".dsh/skills"), "native"],
      [join(dshHome, "skills"), "personal"],
      [join(agentsHome, "skills"), "shared"],
    ])
      await Bun.write(
        join(directory!, name!, "SKILL.md"),
        `---\nname: ${name}\ndescription: test skill\n---\nprivate body`,
      );
    const scopes = await listAgentSkills({
      provider: "dsh",
      agentWorkspaceDirectory: cwd,
      environment: {
        HOME: join(root, "home"),
        DSH_HOME: dshHome,
        DSH_AGENTS_HOME: agentsHome,
      },
    });
    expect(scopes.workspace.entries.map((entry) => entry.name).sort()).toEqual([
      "assigned",
      "native",
    ]);
    expect(scopes.global.entries.map((entry) => entry.name).sort()).toEqual(["personal", "shared"]);
    expect(JSON.stringify(scopes)).not.toContain("private body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
