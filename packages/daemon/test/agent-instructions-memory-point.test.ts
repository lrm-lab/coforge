import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const prompt = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: "/coforge/workspaces/workspace-a/agents/agent-a",
});

test("the standing instructions say memory rides in and must be checked", () => {
  expect(prompt).toContain("they are where the next session picks up");
  expect(prompt).toContain("Check MEMORY.md before asking a human");
  // The Agent cannot judge whether it lacks context, so the fence never asks it to.
  expect(prompt).not.toContain("Read MEMORY.md only when this request lacks context");
  expect(prompt).not.toContain("an inbox notice is not missing context");
});
