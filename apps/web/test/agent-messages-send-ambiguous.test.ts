import { expect, test } from "bun:test";
import { handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import { AppError } from "#src/lib/app-error";

test("a send to a name a member and an Agent share answers 409 AMBIGUOUS_TARGET and sends nothing", async () => {
  const result = await handleAgentMessagesPost(
    new Request("https://server.example/api/agent/v1/messages", {
      method: "POST",
      body: JSON.stringify({ target: "@bob", content: "hello", idempotencyKey: "idem-ambiguous" }),
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: { find: async () => undefined },
      repository: {
        agentTargetFreshness: async () => {
          throw new AppError("AMBIGUOUS_TARGET");
        },
      },
      sender: {
        executeFromAgent: async () => {
          throw new Error("an ambiguous target is never sent");
        },
      },
    },
  );

  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({
    error: "@bob names both a person and an Agent in this Workspace; use @bob~human or @bob~agent",
    code: "AMBIGUOUS_TARGET",
    retryable: false,
  });
});

test.each(["AGENT_DM_CHAIN_LIMIT", "AGENT_DM_RATE_LIMIT"] as const)(
  "a send refused by %s answers 429 and is not retryable",
  async (code) => {
    const result = await handleAgentMessagesPost(
      new Request("https://server.example/api/agent/v1/messages", {
        method: "POST",
        body: JSON.stringify({ target: "@bob", content: "hello", idempotencyKey: "idem-limit" }),
      }),
      { workspaceId: "workspace-1", agentId: "agent-1" },
      {
        requestRecords: { find: async () => undefined },
        repository: { agentTargetFreshness: async () => ({}) },
        sender: {
          executeFromAgent: async () => {
            throw new AppError(code);
          },
        },
      } as never,
    );
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ code, retryable: false });
  },
);
