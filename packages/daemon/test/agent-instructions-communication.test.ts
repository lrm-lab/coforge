import { expect, test } from "bun:test";

import { platformCriticalRules } from "#src/agent-runtime/agent-launch-preparation";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const instructions = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: "/coforge/workspaces/workspace-a/agents/agent-a",
});

test("retains reply instructions and thread addressing without provider tool names", () => {
  expect(instructions).toContain(
    "text outside an executed `coforge message send` command is not delivered",
  );
  expect(instructions).toContain("without asking");
  expect(instructions).toContain("native UI/question tools");
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
  expect(instructions).not.toContain("ask_question");
});

test("system notices stay silent except for tasks assigned to this Agent", () => {
  expect(instructions).toContain(
    "system notices announce state changes and need no reply or acknowledgement, except a task assigned to you: take it over.",
  );
  expect(instructions).not.toContain("take it over and reply in its Task thread");
});

test("protects full read output, held draft continuation, and sub-agent identity boundaries", () => {
  expect(instructions).toContain("never pipe, truncate or discard `message check|read` output");
  expect(instructions).toContain("coforge message continue <id> a|b|c");
  expect(instructions).toContain(
    "Sub-agents have no CoForge identity: instruct them never to send messages, update tasks, react, or schedule reminders.",
  );
});

test("platformCriticalRules adds PowerShell here-string guidance only on win32", () => {
  expect(platformCriticalRules("linux")).toEqual([]);
  expect(platformCriticalRules("darwin")).toEqual([]);
  const winRules = platformCriticalRules("win32");
  expect(winRules).toHaveLength(1);
  expect(winRules[0]).toContain("PowerShell");
  expect(winRules[0]).toContain("@'");
  expect(winRules[0]).toContain("'@ | coforge message send");
});
