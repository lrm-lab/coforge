import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const prompt = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: "/coforge/workspaces/workspace-a/agents/agent-a",
});

test("the standing instructions name MEMORY.md as the index and recovery point", () => {
  expect(prompt).toContain("MEMORY.md is your index and recovery point");
  expect(prompt).toContain(
    "update it after an important interaction or when you learn something new",
  );
  expect(prompt).toContain("write notes/active-context.md before a long task");
  // The Agent cannot judge whether it lacks context, so the fence never asks it to.
  expect(prompt).not.toContain("Read MEMORY.md only when this request lacks context");
  expect(prompt).not.toContain("an inbox notice is not missing context");
});
