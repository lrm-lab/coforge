import { expect, test } from "bun:test";
import { formatDisplayPath } from "#src/features/agents/display-path";
import { treeRowIndent } from "#src/features/agents/profile-panel/agent-workspace-tree";

test("formatDisplayPath leaves short paths intact and preserves distinguishing suffixes on deep paths", () => {
  expect(formatDisplayPath("~/.agents/skills")).toBe("~/.agents/skills");

  const pathA =
    "/Users/frank/Code/enterprise-monorepo-workspace/packages/shared-platform/agents/alpha-bot/.agents/skills";
  const pathB =
    "/Users/frank/Code/enterprise-monorepo-workspace/packages/shared-platform/agents/beta-bot/.agents/skills";
  const formattedA = formatDisplayPath(pathA, 60);
  const formattedB = formatDisplayPath(pathB, 60);

  expect(formattedA).toContain("…");
  expect(formattedA).not.toBe(formattedB);

  const inventoryA =
    "/var/lib/coforge-daemon/workspaces/org-production-cluster-01/agent-workspace-alpha-01";
  const inventoryB =
    "/var/lib/coforge-daemon/workspaces/org-production-cluster-01/agent-workspace-beta-02";
  expect(formatDisplayPath(inventoryA, 56)).not.toBe(formatDisplayPath(inventoryB, 56));
});

test("treeRowIndent uses rem units and caps visual indentation at 8 levels", () => {
  expect(treeRowIndent(1)).toBe("0.25rem");
  expect(treeRowIndent(2)).toBe("1.25rem");
  expect(treeRowIndent(8)).toBe("7.25rem");
  expect(treeRowIndent(16)).toBe("7.25rem");
});
