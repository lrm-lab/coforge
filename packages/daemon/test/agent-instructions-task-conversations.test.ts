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

test("taskConversations stays invariant while artifacts: false omits the Artifacts guide", () => {
  const plain = build();
  expect(plain).toContain("## Artifacts\n");
  for (const artifacts of [true, false]) {
    expect(build({ features: { taskConversations: false, artifacts } })).toBe(
      build({ features: { taskConversations: true, artifacts } }),
    );
  }
  expect(build({ features: { taskConversations: false, artifacts: true } })).toBe(plain);
  const withoutArtifacts = build({ features: { taskConversations: false, artifacts: false } });
  expect(withoutArtifacts).toContain("## Tasks\n");
  expect(withoutArtifacts).not.toContain("## Artifacts\n");
});
