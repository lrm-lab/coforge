import { expect, test } from "bun:test";

import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const instructions = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: "/coforge/workspaces/workspace-a/agents/agent-a",
});

test("retains reply instructions and thread addressing without provider tool names", () => {
  expect(instructions).toContain(
    "text outside an executed `coforge message send` command is not delivered",
  );
  expect(instructions).toContain("Reply to direct user messages");
  expect(instructions).toContain("exact `target=`");
  expect(instructions).toContain("including its thread suffix");
  expect(instructions).toContain(
    "Send the reply on stdin with `coforge message send --target '<target>'`",
  );
  expect(instructions).not.toContain("Bash tool");
});
