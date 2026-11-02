import { expect, test, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COFORGE_CLOUD_COMPUTER_ENV,
  cloudComputerAdditionalSkillPaths,
  cloudComputerAgentSkillsDirectory,
  cloudComputerSharedSkillsDirectory,
  isCloudComputerSkillsEnabled,
  prepareCloudComputerAgentSkills,
} from "#src/cloud-computer-skills";

const previous = Bun.env[COFORGE_CLOUD_COMPUTER_ENV];
const previousWorkspace = Bun.env.WORKSPACE;

afterEach(() => {
  if (previous === undefined) delete Bun.env[COFORGE_CLOUD_COMPUTER_ENV];
  else Bun.env[COFORGE_CLOUD_COMPUTER_ENV] = previous;
  if (previousWorkspace === undefined) delete Bun.env.WORKSPACE;
  else Bun.env.WORKSPACE = previousWorkspace;
});

test("cloud computer skills gate is off by default", () => {
  expect(isCloudComputerSkillsEnabled({})).toBe(false);
  expect(isCloudComputerSkillsEnabled({ [COFORGE_CLOUD_COMPUTER_ENV]: "0" })).toBe(false);
  expect(cloudComputerAdditionalSkillPaths({ agentId: "a1", environment: {} })).toEqual([]);
});

test("cloud computer skills gate enables persistent paths", () => {
  const env = { [COFORGE_CLOUD_COMPUTER_ENV]: "1", WORKSPACE: "/tmp/cloud-ws" };
  expect(isCloudComputerSkillsEnabled(env)).toBe(true);
  expect(cloudComputerSharedSkillsDirectory(env)).toBe("/tmp/cloud-ws/skills");
  expect(cloudComputerAgentSkillsDirectory("agent-1", env)).toBe(
    "/tmp/cloud-ws/agent-skills/agent-1",
  );
  expect(cloudComputerAdditionalSkillPaths({ agentId: "agent-1", environment: env })).toEqual([
    "/tmp/cloud-ws/skills",
    "/tmp/cloud-ws/agent-skills/agent-1",
  ]);
});

test("prepareCloudComputerAgentSkills is a no-op when gate is off", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-skills-gate-off-"));
  try {
    const result = await prepareCloudComputerAgentSkills({
      agentId: "agent-1",
      agentWorkspaceDirectory: root,
      environment: {},
    });
    expect(result.enabled).toBe(false);
    expect(result.directory).toBe(join(root, ".pi", "skills"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareCloudComputerAgentSkills migrates legacy .pi/skills when gate is on", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-skills-gate-on-"));
  const workspace = join(root, "workspace");
  try {
    await mkdir(join(root, ".pi", "skills", "legacy-skill"), { recursive: true });
    await Bun.write(
      join(root, ".pi", "skills", "legacy-skill", "SKILL.md"),
      "---\nname: legacy-skill\ndescription: x\n---\n",
    );
    const env = { [COFORGE_CLOUD_COMPUTER_ENV]: "1", WORKSPACE: workspace };
    const result = await prepareCloudComputerAgentSkills({
      agentId: "agent-9",
      agentWorkspaceDirectory: root,
      environment: env,
    });
    expect(result.enabled).toBe(true);
    expect(result.directory).toBe(join(workspace, "agent-skills", "agent-9"));
    expect(
      await Bun.file(join(workspace, "agent-skills", "agent-9", "legacy-skill", "SKILL.md")).text(),
    ).toContain("legacy-skill");
    // Mirrored back so the default Pi loader still finds the skill under .pi/skills.
    expect(
      await Bun.file(join(root, ".pi", "skills", "legacy-skill", "SKILL.md")).text(),
    ).toContain("legacy-skill");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
