import { expect, test } from "bun:test";
import { m } from "#src/paraglide/messages";

test("agent_skills_title interpolates the global+workspace entry count", () => {
  expect(m.agent_skills_title({ count: 3 })).toContain("3");
});

test("the reason copy no longer tells the viewer to try refreshing (Retry is the button)", () => {
  for (const copy of [
    m.agent_skills_offline(),
    m.agent_skills_timeout(),
    m.agent_skills_unavailable(),
    m.agent_skills_error(),
  ]) {
    expect(copy.toLowerCase()).not.toContain("try refresh");
    expect(copy.toLowerCase()).not.toContain("refresh after");
  }
});

test("the deleted strings (caveat, refresh button, per-entry columns, directory list) are gone", () => {
  const messages = m as unknown as Record<string, unknown>;
  for (const key of [
    "agent_skills_caveat",
    "agent_skills_refresh",
    "agent_skills_name",
    "agent_skills_description",
    "agent_skills_source",
    "agent_skills_directories",
    "agent_skills_partial",
    "agent_skills_scope_error",
    "agent_skills_unsupported",
    "agent_skills_empty",
    "agent_skills_directory_scanned",
    "agent_skills_directory_missing",
    "agent_skills_directory_unreadable",
    "agent_skills_directory_unsupported",
  ])
    expect(messages[key]).toBeUndefined();
});

test("the empty-group and group-label copy exists for both scopes", () => {
  expect(String(m.agent_skills_global())).toBe("Global");
  expect(String(m.agent_skills_workspace())).toBe("Workspace");
  expect(m.agent_skills_global_empty().length).toBeGreaterThan(0);
  expect(m.agent_skills_workspace_empty().length).toBeGreaterThan(0);
});
