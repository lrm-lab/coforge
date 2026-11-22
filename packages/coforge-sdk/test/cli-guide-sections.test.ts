import { describe, expect, test } from "bun:test";
import {
  buildCoforgeCliGuideSections,
  buildExternalAgentGuide,
  FIRST_PARTY_GUIDE_ENTRIES,
  resolveFeatureGuides,
} from "../src/agent/guide";

describe("cli-guide-sections", () => {
  test("managed audience preserves daemon standing prompt sections and capability feature guides", () => {
    const sections = buildCoforgeCliGuideSections({
      audience: "managed",
      capabilities: {
        cloudDesktop: true,
        cloudSkills: {
          sharedDirectory: "/workspace/skills",
          agentDirectory: "/workspace/agent-skills/agent-1",
        },
      },
      extraCriticalRules: ["Extra rule."],
    });
    expect(sections.communication).toContain("without asking");
    expect(sections.communication).toContain("native UI/question tools");
    expect(sections.communication).toContain("Or create a unique file in your Agent workspace;");
    expect(sections.messages).toContain("never pipe, truncate or discard");
    expect(sections.messages).toContain("coforge message continue <id> a|b|c");
    expect(sections.messages).toContain("A `held` count means the daemon has not shown");
    expect(sections.messages).toContain("`system.reminder` delivers due reminders as App items");
    expect(sections.execution).toContain("Local memory: save decisions/corrections with sources.");
    expect(sections.execution).not.toContain("Persistent skills on this cloud computer");
    expect(sections.safety).toContain("Sub-agents have no CoForge identity");
    expect(sections.safety).not.toContain("page:fill");
    expect(sections.safety).toContain("Extra rule.");
    expect(sections.tasks).toContain("## Tasks\n");
    expect(sections.artifacts).toContain("## Artifacts\n");
    expect(sections.artifacts).toContain("coforge artifact push");
    expect(sections.artifacts).toContain("?embed=1");
    expect(sections.artifacts).toContain("coforge manual get artifacts");
    expect(sections.cloudDesktop).toContain("## Cloud desktop\n");
    expect(sections.cloudDesktop).toContain("post a `page:fill` action card");
    expect(sections.cloudDesktop).toContain("`desktop:takeover`");
    expect(sections.cloudComputerSkills).toContain("## Cloud computer skills\n");
    expect(sections.cloudComputerSkills).toContain("/workspace/skills/<name>/SKILL.md");
    expect(sections.cloudComputerSkills).toContain(
      "/workspace/agent-skills/agent-1/<name>/SKILL.md",
    );
  });

  test("external audience omits Computer/daemon/memory-file and cloud-computer guides while keeping shared rules", () => {
    const sections = buildCoforgeCliGuideSections({
      audience: "external",
      capabilities: {
        cloudDesktop: true,
        cloudSkills: {
          sharedDirectory: "/workspace/skills",
          agentDirectory: "/workspace/agent-skills/agent-1",
        },
      },
    });
    const combined = Object.values(sections).join("\n\n");
    expect(combined).not.toContain("Agent workspace");
    expect(combined).not.toContain("held` count");
    expect(combined).not.toContain("system.reminder");
    expect(combined).not.toContain("Persistent skills on this cloud computer");
    expect(combined).not.toContain("MEMORY.md");
    expect(combined).not.toContain("page:fill");
    expect(combined).not.toContain("coforge message continue");
    expect(combined).toContain("without asking");
    expect(combined).toContain("native UI/question tools");
    expect(combined).toContain("never pipe, truncate or discard");
    expect(combined).toContain("Sub-agents have no CoForge identity");
    expect(combined).toContain("coforge message check");
    expect(combined).toContain("coforge task create --target");
    expect(combined).toContain("coforge task list --mine");
    expect(combined).toContain("## Tasks\n");
    expect(combined).toContain("## Artifacts\n");
    expect(combined).toContain("?embed=1");
  });

  test("feature guide registry gates Artifacts and cloud-computer entries declaratively", () => {
    expect(FIRST_PARTY_GUIDE_ENTRIES.map((entry) => entry.id)).toEqual([
      "tasks",
      "artifacts",
      "cloudDesktop",
      "cloudComputerSkills",
    ]);
    const enabled = resolveFeatureGuides({ audience: "managed" });
    expect(enabled.map((entry) => entry.id)).toEqual(["tasks", "artifacts"]);
    const cloudEnabled = resolveFeatureGuides({
      audience: "managed",
      capabilities: {
        cloudDesktop: true,
        cloudSkills: {
          sharedDirectory: "/workspace/skills",
          agentDirectory: "/workspace/agent-skills/agent-1",
        },
      },
    });
    expect(cloudEnabled.map((entry) => entry.id)).toEqual([
      "tasks",
      "artifacts",
      "cloudDesktop",
      "cloudComputerSkills",
    ]);
    const disabled = resolveFeatureGuides({
      audience: "managed",
      features: { artifacts: false },
    });
    expect(disabled.map((entry) => entry.id)).toEqual(["tasks"]);
    const sections = buildCoforgeCliGuideSections({
      audience: "managed",
      features: { artifacts: false },
    });
    expect(sections.artifacts).toBeUndefined();
    expect(sections.cloudDesktop).toBeUndefined();
    expect(sections.cloudComputerSkills).toBeUndefined();
    expect(sections.tasks).toContain("## Tasks\n");

    const checksOff = buildCoforgeCliGuideSections({
      audience: "managed",
      features: { artifacts: true, artifactChecks: false },
    });
    expect(checksOff.artifacts).toContain("## Artifacts\n");
    expect(checksOff.artifacts).not.toContain("coforge artifact check");
    expect(buildCoforgeCliGuideSections({ audience: "managed" }).artifacts).toContain(
      "coforge artifact check <id> --wait",
    );
  });

  test("buildExternalAgentGuide renders identity, context, CLI setup and shared sections", () => {
    const guide = buildExternalAgentGuide({
      agent: {
        id: "agent-1",
        name: "alice",
        displayName: "Alice",
        description: "## Heading\nHelps with builds.",
        role: "member",
      },
      workspace: { id: "ws-1", slug: "lrm-lab", name: "LRM Lab" },
    });
    expect(guide).toContain('You are "Alice", an external AI agent in CoForge.');
    expect(guide).toContain("- Role: Heading Helps with builds.");
    expect(guide).toContain("- Username: @alice");
    expect(guide).toContain("- Workspace: LRM Lab (lrm-lab)");
    expect(guide).toContain("- Mode: external (no Computer or daemon)");
    expect(guide).toContain("--profile <slug>");
    expect(guide).toContain("COFORGE_PROFILE=<slug>");
    expect(guide).toContain("reminders_unsupported_for_external_agents");
    expect(guide).toContain("## Artifacts\n");
    expect(guide).toContain("?embed=1");
  });
});
