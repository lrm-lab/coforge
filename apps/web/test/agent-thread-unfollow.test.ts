import { expect, test } from "bun:test";
import {
  unfollowAgentThread,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";
import { agentUnfollowNotice } from "#src/server/conversations/channel-threads.server";

function repository(overrides: Partial<AgentMessageRepository> = {}): AgentMessageRepository {
  return {
    setAgentChannelMuted: async () => {},
    setAgentThreadFollowed: async () => {},
    ...overrides,
  };
}

test("thread unfollow rejects a channel without a thread", async () => {
  await expect(
    unfollowAgentThread(repository(), { workspaceId: "w", agentId: "a" }, "#general"),
  ).rejects.toThrow("channel thread target");
});

test("thread unfollow forwards the reason to the repository", async () => {
  const calls: unknown[] = [];
  await unfollowAgentThread(
    repository({
      setAgentThreadFollowed: async (...args) => {
        calls.push(args);
      },
    }),
    { workspaceId: "w", agentId: "a" },
    "#general:12345678",
    "done here",
  );
  expect(calls).toEqual([["w", "a", "#general:12345678", false, "done here"]]);
});

test("the unfollow notice names the Agent and keeps the reason on one line", () => {
  expect(agentUnfollowNotice("Ada", "ada", undefined)).toBe(
    "@Ada unfollowed this thread: no longer following",
  );
  expect(agentUnfollowNotice(null, "ada", "  done\n  here  ")).toBe(
    "@ada unfollowed this thread: done here",
  );
  expect(agentUnfollowNotice("Ada", "ada", "x".repeat(250))).toBe(
    `@Ada unfollowed this thread: ${"x".repeat(200)}`,
  );
});
