import { expect, test } from "bun:test";
import { canManageAgent } from "#src/features/agents/profile-panel/agent-profile-queries";

test("nobody manages a bot from its profile, not even its creator or an admin", () => {
  expect(canManageAgent({ canManageAgentRole: true, ownedByCurrentUser: true })).toBe(true);
  expect(
    canManageAgent({ canManageAgentRole: true, ownedByCurrentUser: true, appBot: { appKey: "a" } }),
  ).toBe(false);
});
