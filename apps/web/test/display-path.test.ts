import { expect, test } from "bun:test";
import {
  formatDisplayPath,
  splitDisplayPath,
  workspacePathMaxLength,
} from "#src/features/agents/display-path";
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

test("splitDisplayPath separates parent prefix from active leaf segment across separators", () => {
  expect(splitDisplayPath("/home/coforge/agents/donald")).toEqual({
    prefix: "/home/coforge/agents/",
    leaf: "donald",
  });
  expect(splitDisplayPath("/home/coforge/agents/donald/")).toEqual({
    prefix: "/home/coforge/agents/",
    leaf: "donald",
  });
  expect(splitDisplayPath("C:\\Users\\frank\\donald")).toEqual({
    prefix: "C:\\Users\\frank\\",
    leaf: "donald",
  });
  expect(splitDisplayPath("/")).toEqual({ prefix: "", leaf: "/" });
  expect(splitDisplayPath("donald")).toEqual({ prefix: "", leaf: "donald" });
  expect(splitDisplayPath("")).toEqual({ prefix: "", leaf: "" });
});

test("workspacePathMaxLength scales display budget with pane width and clamps extremes", () => {
  expect(workspacePathMaxLength(0)).toBe(56);
  expect(workspacePathMaxLength(320)).toBe(24);
  expect(workspacePathMaxLength(720)).toBeGreaterThan(56);
  expect(workspacePathMaxLength(2000)).toBe(80);
});

test("treeRowIndent uses rem units and caps visual indentation at 8 levels", () => {
  expect(treeRowIndent(1)).toBe("0.25rem");
  expect(treeRowIndent(2)).toBe("1.25rem");
  expect(treeRowIndent(8)).toBe("7.25rem");
  expect(treeRowIndent(16)).toBe("7.25rem");
});

test("treeRowIndent compact mode tightens narrow-pane step and caps at 6 levels", () => {
  expect(treeRowIndent(1, true)).toBe("0.25rem");
  expect(treeRowIndent(2, true)).toBe("0.875rem");
  expect(treeRowIndent(6, true)).toBe("3.375rem");
  expect(treeRowIndent(10, true)).toBe("3.375rem");
});
