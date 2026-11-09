import { expect, test } from "bun:test";

import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const instructions = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: "/coforge/workspaces/workspace-a/agents/agent-a",
});

test("retains reply instructions and thread addressing without provider tool names", () => {
  expect(instructions).toContain(
    "text outside an executed `coforge message send` command is not delivered",
  );
  // task #741: a reply goes to the target of the message being answered (thread suffix kept),
  // while a new topic, a summary or a proactive notice starts at the top level without a suffix.
  expect(instructions).toContain(
    "Reply to the target of the message you answer (keep its thread suffix); start new topics, summaries and proactive notices at the top level, without a suffix.",
  );
  expect(instructions).not.toContain("Reuse exact `target=`, including its thread suffix");
  expect(instructions).toContain(
    "Send the reply on stdin with `coforge message send --target '<target>'`",
  );
  expect(instructions).not.toContain("Bash tool");
});

test("system notices stay silent except for tasks assigned to this Agent", () => {
  expect(instructions).toContain(
    "system notices announce state changes and need no reply or acknowledgement, except a task assigned to you: take it over and reply in its Task thread.",
  );
});
