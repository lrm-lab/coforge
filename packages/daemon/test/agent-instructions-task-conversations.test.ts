import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const agentWorkspaceDirectory = "/coforge/workspaces/workspace-a/agents/agent-a";
const build = (identity?: Parameters<typeof buildCoforgeAgentInstructions>[0]["identity"]) =>
  buildCoforgeAgentInstructions({ agentWorkspaceDirectory, identity });

test("the prompt always carries the task conversations block with the quoted-ref rule", () => {
  const prompt = build();
  expect(prompt).toContain("## Tasks\n");
  expect(prompt).toContain("ALWAYS quote refs (an unquoted # starts a shell comment)");
  expect(prompt).toContain("coforge task view|read|reply|follow '<ref>'");
  expect(prompt).toContain("--message-id");
  expect(prompt).toContain("--alongside");
  expect(prompt).toContain("--blocked-by");
  expect(prompt).toContain("--parent");
  // A task belongs to a Project when its creator can tell which one; the manual's rule.
  expect(prompt).toContain("--project <slug>");
  expect(prompt).toContain("workspace info --projects");
  expect(prompt).toContain("else ask in the task");
});

test("the launch feature value does not change the prompt", () => {
  const plain = build();
  for (const taskConversations of [true, false])
    for (const artifacts of [true, false])
      expect(build({ features: { taskConversations, artifacts } })).toBe(
        build({ features: { taskConversations: true, artifacts } }),
      );
  expect(build({ features: { taskConversations: false, artifacts: false } })).toBe(plain);
});
