import { expect, test } from "bun:test";
import {
  reactToAgentMessage,
  resolveAgentMessage,
  type AgentMessageRepository,
} from "#src/server/agents/agent-messages.server";

function repository(overrides: Partial<AgentMessageRepository> = {}): AgentMessageRepository {
  return {
    setAgentChannelMuted: async () => {},
    setAgentThreadFollowed: async () => {},
    ...overrides,
  };
}

test("resolve maps Date values at the application boundary", async () => {
  const calls: unknown[] = [];
  const result = await resolveAgentMessage(
    repository({
      resolveAgentMessage: async (...args) => {
        calls.push(args);
        return {
          id: "message-1",
          sequence: 1,
          senderKind: "human" as const,
          senderHandle: "ada",
          senderDescription: "",
          target: "#general",
          body: "hello",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
          attachments: [],
        };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "abcd1234",
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234"]]);
  expect(result.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("resolve without repository support fails clearly", async () => {
  await expect(
    resolveAgentMessage(repository(), { workspaceId: "w", agentId: "a" }, "abcd1234"),
  ).rejects.toThrow("Agent message resolve is unavailable");
});

test("react preserves the authenticated scope and reaction fields", async () => {
  const calls: unknown[] = [];
  const result = await reactToAgentMessage(
    repository({
      setAgentMessageReaction: async (...args) => {
        calls.push(args);
        return { messageId: "message-1" };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "abcd1234",
    "👍",
    true,
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234", "👍", true]]);
  expect(result).toEqual({ messageId: "message-1" });
});

test("react rejects an emoji with whitespace before reaching the repository", async () => {
  await expect(
    reactToAgentMessage(
      repository({ setAgentMessageReaction: async () => ({ messageId: "message-1" }) }),
      { workspaceId: "w", agentId: "a" },
      "abcd1234",
      "a b",
      true,
    ),
  ).rejects.toThrow("reaction emoji must be one to sixteen characters without whitespace");
});

test("react rejects an emoji longer than sixteen characters", async () => {
  await expect(
    reactToAgentMessage(
      repository({ setAgentMessageReaction: async () => ({ messageId: "message-1" }) }),
      { workspaceId: "w", agentId: "a" },
      "abcd1234",
      "x".repeat(17),
      true,
    ),
  ).rejects.toThrow("reaction emoji must be one to sixteen characters without whitespace");
});
