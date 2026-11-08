import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const agentWorkspaceDirectory = "/coforge/workspaces/workspace-a/agents/agent-a";
const build = (identity?: Parameters<typeof buildCoforgeAgentInstructions>[0]["identity"]) =>
  buildCoforgeAgentInstructions({ agentWorkspaceDirectory, identity });

test("task conversations on adds the block with the quoted-ref rule", () => {
  const on = build({ features: { taskConversations: true, artifacts: false } });
  expect(on).toContain("Tasks have their own conversations");
  expect(on).toContain("ALWAYS quote the ref");
  expect(on).toContain("coforge task reply");
  expect(on).toContain("coforge task read");
  expect(on).toContain("coforge task list --following");
  expect(on).toContain("--message-id");
  expect(on).toContain("--alongside");
  expect(on).toContain("--blocked-by");
  expect(on).toContain("--parent");
  // A task belongs to a Project when its creator can tell which one; the manual's rule.
  expect(on).toContain("--project <slug>");
  expect(on).toContain("coforge workspace info --projects");
  expect(on).toContain("rather than guessing");
});

test("task conversations off or absent leaves the prompt exactly as before", () => {
  const plain = build();
  expect(build({ features: { taskConversations: false, artifacts: false } })).toBe(plain);
  expect(build({ features: { taskConversations: false, artifacts: true } })).toBe(plain);
  expect(plain).not.toContain("Tasks have their own conversations");
  expect(plain).not.toContain("--blocked-by");
  expect(plain).toContain("coforge task claim --target '<channel>' --message-id <root-message-id>");
});
