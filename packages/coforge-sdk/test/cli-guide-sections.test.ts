import { describe, expect, test } from "bun:test";
import {
  buildCoforgeCliGuideSections,
  buildExternalAgentGuide,
} from "../src/agent/cli-guide-sections";

describe("cli-guide-sections", () => {
  test("managed audience preserves daemon standing prompt sections verbatim", () => {
    const sections = buildCoforgeCliGuideSections({
      audience: "managed",
      capabilities: { cloudDesktop: true },
      cloudSkillsGuidance: "Cloud skills here.\n",
      extraCriticalRules: ["Extra rule."],
    });
    expect(sections.communication).toContain("Or create a unique file in your Agent workspace;");
    expect(sections.messages).toContain("A `held` count means the daemon has not shown");
    expect(sections.messages).toContain("`system.reminder` delivers due reminders as App items");
    expect(sections.execution).toContain("Cloud skills here.");
    expect(sections.execution).toContain("Local memory: save decisions/corrections with sources.");
    expect(sections.safety).toContain("post a `page:fill` action card");
    expect(sections.safety).toContain("Extra rule.");
  });

  test("external audience omits Computer/daemon/memory-file assumptions and keeps shared rules", () => {
    const sections = buildCoforgeCliGuideSections({
      audience: "external",
      capabilities: { cloudDesktop: true },
      cloudSkillsGuidance: "Cloud skills here.\n",
    });
    const combined = Object.values(sections).join("\n\n");
    expect(combined).not.toContain("Agent workspace");
    expect(combined).not.toContain("held` count");
    expect(combined).not.toContain("system.reminder");
    expect(combined).not.toContain("Cloud skills here.");
    expect(combined).not.toContain("MEMORY.md");
    expect(combined).not.toContain("page:fill");
    expect(combined).toContain("coforge message check");
    expect(combined).toContain("coforge task claim");
    expect(combined).toContain("coforge task list --mine");
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
  });
});
