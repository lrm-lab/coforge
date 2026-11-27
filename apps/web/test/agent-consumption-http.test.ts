import { expect, test } from "bun:test";
import { handleAgentMessagesGet, handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import { handleAgentTaskPost } from "#src/routes/api/agent/v1/tasks";
import { agentHistoryConsumptionScope } from "#src/server/db/repositories/resolved-agent-target.server";

const messagePost = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });

test.each([true, false])(
  "scoped send evidence applies only to the resolved thread (%s)",
  async (matches) => {
    const consumptionScope = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      threadRootId: "22222222-2222-4222-8222-222222222222",
    };
    const target = "#triage:22222222";
    const bounded: number[] = [];
    const exact: (readonly number[] | undefined)[] = [];
    const response = await handleAgentMessagesPost(
      messagePost({
        target,
        content: "reply",
        seenUpToSeq: 31,
        seenExactSeqs: [32],
        consumptionEvidence: [
          {
            target: matches
              ? consumptionScope
              : { conversationId: consumptionScope.conversationId },
            entry: { seq: 4, exactSeqs: [6] },
          },
        ],
      }),
      { workspaceId: "workspace-1", agentId: "agent-1" },
      {
        requestRecords: { find: async () => undefined },
        repository: {
          agentTargetFreshness: async () => ({
            consumptionScope,
            boundSeenSequence: async (seq) => {
              bounded.push(seq);
              return seq;
            },
            readPending: async (_seen, excluded) => {
              exact.push(excluded);
              return [];
            },
          }),
        },
        sender: { executeFromAgent: async () => ({ id: "sent" }) },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ consumptionScope });
    expect(bounded).toEqual(matches ? [4] : []);
    expect(exact).toEqual([matches ? [6] : undefined]);
  },
);

test("a channel read opts into the server's resolved conversation scope", async () => {
  const resolved = {
    conversationId: "channel-conversation",
    threadRootId: null,
    canonicalTarget: "#general",
    isChannel: true,
  };
  const response = await handleAgentMessagesGet(
    new Request(
      "https://server.example/api/agent/v1/messages?target=%23general&consumptionScope=true",
    ),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      readMessagesPage: async (_workspace, agentId, _target, page) => ({
        messages: [],
        hasOlder: false,
        hasNewer: false,
        modelSeenUpToSeq: 5,
        consumptionScope: agentHistoryConsumptionScope(agentId, resolved, page.consumptionScope),
      }),
    },
  );
  expect(await response.json()).toMatchObject({
    modelSeenUpToSeq: 5,
    consumptionScope: { conversationId: resolved.conversationId },
  });
  expect(agentHistoryConsumptionScope("agent-1", resolved)).toBeUndefined();
});

test("the Task POST uses scoped evidence only in its resolved conversation", async () => {
  const consumptionScope = { conversationId: "11111111-1111-4111-8111-111111111111" };
  const bounded: number[] = [];
  const exact: (readonly number[] | undefined)[] = [];
  const response = await handleAgentTaskPost(
    new Request("https://server.example/api/agent/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        operation: "claim",
        idempotencyKey: "same-key",
        target: "#tasks",
        number: 7,
        consumptionEvidence: [
          {
            target: { conversationId: "22222222-2222-4222-8222-222222222222" },
            entry: { seq: 31, exactSeqs: [32] },
          },
          { target: consumptionScope, entry: { seq: 5, exactSeqs: [7] } },
        ],
      }),
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { execute: async () => ({ tasks: [] }) },
    async () => ({
      scope: {} as never,
      freshness: {
        consumptionScope,
        boundSeenSequence: async (seq) => {
          bounded.push(seq);
          return seq;
        },
        readPending: async (_seen, excluded) => {
          exact.push(excluded);
          return [];
        },
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ idempotencyKey: "same-key", consumptionScope });
  expect(bounded).toEqual([5]);
  expect(exact).toEqual([[7]]);
});

test("malformed scoped Task evidence does not look like a legacy unknown-field refusal", async () => {
  const response = await handleAgentTaskPost(
    new Request("https://server.example/api/agent/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        operation: "create",
        idempotencyKey: "same-key",
        title: "Valid legacy Task",
        consumptionEvidence: [
          {
            target: { conversationId: "conversation" },
            entry: { seq: "31" },
          },
        ],
      }),
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      execute: async () => {
        throw new Error("invalid request reached the board");
      },
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "invalid consumptionEvidence",
    code: "INVALID_INPUT",
  });
});
