import { expect, test } from "bun:test";

import { platformCriticalRules } from "#src/agent-runtime/agent-launch-preparation";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const instructions = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: "/coforge/workspaces/workspace-a/agents/agent-a",
});

test("retains reply instructions and thread addressing without provider tool names", () => {
  expect(instructions).toContain("Only `coforge message send` delivers chat replies");
  expect(instructions).toContain("without asking");
  expect(instructions).toContain("native UI/question tools");
  expect(instructions).toContain("Default reply location: keep the target and thread suffix.");
  expect(instructions).not.toContain("Reuse exact `target=`, including its thread suffix");
  expect(instructions).toContain("Send on stdin with a quoted here-document");
  expect(instructions).not.toContain("Bash tool");
  expect(instructions).not.toContain("ask_question");
});

test("status notices need no reply while assignments and reminders still apply", () => {
  expect(instructions).toContain("System status notices need no reply or acknowledgment.");
  expect(instructions).toContain("Take over tasks assigned to you.");
  expect(instructions).toContain("`system.reminder` delivers due reminders as App items.");
  expect(instructions).toContain("`coforge reminder list` after wake.");
  expect(instructions).not.toContain("take it over and reply in its Task thread");
});

test("protects full read output, held draft continuation, and sub-agent identity boundaries", () => {
  expect(instructions).toContain("Never pipe, truncate or discard `message check|read` output");
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
  expect(winRules[0]).toContain("@'\n...\n'@ | coforge message send");
  expect(winRules[0]).not.toContain("\\n");
});
