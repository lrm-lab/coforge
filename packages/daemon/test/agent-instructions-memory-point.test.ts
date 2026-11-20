import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const prompt = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: "/coforge/workspaces/workspace-a/agents/agent-a",
});

test("short memory guidance preserves current-context use and evidence-backed recall", () => {
  expect(prompt).toContain("save decisions/corrections with sources");
  expect(prompt).toContain("Use current context first");
  expect(prompt).toContain("before re-asking");
  expect(prompt).toContain("Reference only");
  expect(prompt).toContain("reusable lessons or explicit requests, not task logs");
  expect(prompt).toContain("Correct via get + save --revision");
  expect(prompt).toContain("workspace-authorized knowledge");
  expect(prompt).toContain("keep private notes local");
  const guidance = prompt.split("Local memory:")[1]!.split("\n")[0]!;
  expect(Buffer.byteLength(guidance)).toBeLessThan(700);
});
