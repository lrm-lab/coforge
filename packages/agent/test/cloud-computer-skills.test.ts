import { expect, test, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises";
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
    expect(
      await Bun.file(join(root, ".pi", "skills", "legacy-skill", "SKILL.md")).text(),
    ).toContain("legacy-skill");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareCloudComputerAgentSkills removes migrated cloud-computer skills on a local computer", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-skills-migrated-local-"));
  try {
    await Bun.write(
      join(root, ".pi", "skills", "browser-login", "SKILL.md"),
      "---\nname: browser-login\ndescription: Cloud browser login\n---\n",
    );
    await Bun.write(
      join(root, ".pi", "skills", "cloud-computer-overview", "SKILL.md"),
      "---\nname: cloud-computer-overview\ndescription: Cloud overview\n---\n",
    );
    await Bun.write(
      join(root, ".pi", "skills", "custom-local", "SKILL.md"),
      "---\nname: custom-local\ndescription: User skill\n---\n",
    );
    const result = await prepareCloudComputerAgentSkills({
      agentId: "agent-1",
      agentWorkspaceDirectory: root,
      environment: {},
    });
    expect(result.enabled).toBe(false);
    expect(await Bun.file(join(root, ".pi", "skills", "browser-login", "SKILL.md")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(root, ".pi", "skills", "cloud-computer-overview", "SKILL.md")).exists(),
    ).toBe(false);
    expect(await Bun.file(join(root, ".pi", "skills", "custom-local", "SKILL.md")).exists()).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareCloudComputerAgentSkills never traverses symlinked .pi or .pi/skills directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-skills-symlink-guard-"));
  try {
    const externalSkills = join(root, "external-skills");
    const wsSymlinkSkills = join(root, "ws-symlink-skills");
    const wsSymlinkDotPi = join(root, "ws-symlink-dotpi");
    const externalDotPi = join(root, "external-dotpi");

    await Bun.write(
      join(externalSkills, "browser-login", "SKILL.md"),
      "---\nname: browser-login\ndescription: External\n---\n",
    );
    await mkdir(join(wsSymlinkSkills, ".pi"), { recursive: true });
    await symlink(externalSkills, join(wsSymlinkSkills, ".pi", "skills"));

    await Bun.write(
      join(externalDotPi, "skills", "cloud-computer-overview", "SKILL.md"),
      "---\nname: cloud-computer-overview\ndescription: External\n---\n",
    );
    await mkdir(wsSymlinkDotPi, { recursive: true });
    await symlink(externalDotPi, join(wsSymlinkDotPi, ".pi"));

    await prepareCloudComputerAgentSkills({
      agentId: "agent-1",
      agentWorkspaceDirectory: wsSymlinkSkills,
      environment: {},
    });
    await prepareCloudComputerAgentSkills({
      agentId: "agent-1",
      agentWorkspaceDirectory: wsSymlinkDotPi,
      environment: {},
    });

    expect(await Bun.file(join(externalSkills, "browser-login", "SKILL.md")).exists()).toBe(true);
    expect(
      await Bun.file(join(externalDotPi, "skills", "cloud-computer-overview", "SKILL.md")).exists(),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resourceLoaderOptionsForSession strips cloud-only skills, their diagnostics, and cloud APPEND_SYSTEM on local computers", async () => {
  const { resourceLoaderOptionsForSession } = await import("#src/session-resource-loader");
  const localLoader = resourceLoaderOptionsForSession({
    instructions: "Local instructions.",
    environment: {},
  });
  const localDiagnostics = [
    {
      type: "collision" as const,
      message: "skill collision",
      collision: {
        resourceType: "skill" as const,
        name: "browser-login",
        winnerPath: "/a/browser-login/SKILL.md",
        loserPath: "/b/browser-login/SKILL.md",
      },
    },
    {
      type: "warning" as const,
      message: "frontmatter warning",
      path: "/Users/frank/.agents/skills/cloud-computer-overview/SKILL.md",
    },
    {
      type: "warning" as const,
      message: "broken local skill",
      path: "/Users/frank/.agents/skills/broken-local/SKILL.md",
    },
  ];
  const overridden = localLoader.skillsOverride?.({
    skills: [
      { name: "browser-login" } as never,
      { name: "cloud-computer-overview" } as never,
      { name: "ego-browser" } as never,
    ],
    diagnostics: localDiagnostics,
  });
  expect(overridden?.skills).toEqual([{ name: "ego-browser" } as never]);
  expect(overridden?.diagnostics).toEqual([localDiagnostics[2]!]);
  expect(
    localLoader.appendSystemPromptOverride?.([
      "# CoForge 云电脑身份与能力\n你运行在云电脑中。",
      "User custom append prompt.",
    ]),
  ).toEqual(["User custom append prompt."]);

  const cloudLoader = resourceLoaderOptionsForSession({
    instructions: "Cloud instructions.",
    environment: { [COFORGE_CLOUD_COMPUTER_ENV]: "1" },
  });
  expect(cloudLoader.skillsOverride).toBeUndefined();
  expect(cloudLoader.appendSystemPromptOverride).toBeUndefined();
});
