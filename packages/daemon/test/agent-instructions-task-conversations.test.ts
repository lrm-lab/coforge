import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const agentWorkspaceDirectory = "/coforge/workspaces/workspace-a/agents/agent-a";
const build = (identity?: Parameters<typeof buildCoforgeAgentInstructions>[0]["identity"]) =>
  buildCoforgeAgentInstructions({ agentWorkspaceDirectory, identity });

test("task conversations on adds the block with the quoted-ref rule", () => {
  const on = build({ features: { taskConversations: true } });
  expect(on).toContain("Tasks have their own conversations");
  expect(on).toContain("ALWAYS quote the ref");
  expect(on).toContain("coforge task reply");
  expect(on).toContain("coforge task read");
  expect(on).toContain("coforge task list --following");
  expect(on).toContain("--message-id");
  expect(on).toContain("--alongside");
});

test("task conversations off or absent leaves the prompt exactly as before", () => {
  const plain = build();
  expect(build({ features: {} })).toBe(plain);
  expect(build({ features: { taskConversations: false } })).toBe(plain);
  expect(plain).not.toContain("Tasks have their own conversations");
  expect(plain).toContain("coforge task claim --target '<channel>' --message-id <root-message-id>");
});
