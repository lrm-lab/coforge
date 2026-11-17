import { expect, test } from "bun:test";
import { handleAgentThreadFollowPost } from "#src/routes/api/agent/v1/threads_.$thread.follow";
import { externalAgentFeature } from "#src/server/agents/external-agent-capabilities.server";
import type { AgentMessageRepository } from "#src/server/agents/agent-messages.server";

test("POST /api/agent/v1/threads/:thread/follow follows a channel thread and rejects non-thread targets", async () => {
  const calls: Array<{ workspaceId: string; agentId: string; target: string; followed: boolean }> =
    [];
  const repo: AgentMessageRepository = {
    setAgentChannelMuted: async () => ({}),
    setAgentThreadFollowed: async (workspaceId, agentId, target, followed) => {
      calls.push({ workspaceId, agentId, target, followed });
      return { followed };
    },
  };

  const ok = await handleAgentThreadFollowPost(
    new Request("https://server.example/api/agent/v1/threads/%23general%3A12345678/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "11111111-2222-3333-4444-555555555555" }),
    }),
    "#general:12345678",
    { workspaceId: "ws-1", agentId: "agent-1" },
    repo,
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({
    idempotencyKey: "11111111-2222-3333-4444-555555555555",
    target: "#general:12345678",
    followed: true,
  });
  expect(calls).toEqual([
    {
      workspaceId: "ws-1",
      agentId: "agent-1",
      target: "#general:12345678",
      followed: true,
    },
  ]);

  const bad = await handleAgentThreadFollowPost(
    new Request("https://server.example/api/agent/v1/threads/%23general/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "11111111-2222-3333-4444-555555555555" }),
    }),
    "#general",
    { workspaceId: "ws-1", agentId: "agent-1" },
    repo,
  );
  expect(bad.status).toBe(400);

  expect(externalAgentFeature("POST", "/api/agent/v1/threads/#general:12345678/follow")).toBe(
    "threads",
  );
});
