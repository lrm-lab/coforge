import { expect, test } from "bun:test";
import type { TaskRequest } from "@lrm/coforge-sdk/internal";
import { defaultAgentTaskHttpClient } from "#src/connection/agent-http-clients";
import { messageRecord } from "./fixtures/message-record";
import { createMessageHarness } from "./fixtures/message-harness";
import { taskDelivery, temporaryReadPositionState } from "./fixtures/read-position-acceptance";

const target = "@ada";
const conversationId = "f0f6f9bf-0ef0-4a48-aa2c-dc6e8b5210e5";
const command = {
  operation: "update",
  idempotencyKey: "task-post-acceptance",
  number: 7,
  target,
  title: "Review scope handoff",
  expectedRevision: 4,
} satisfies TaskRequest;

const strictRefusal = { error: "invalid task request", code: "INVALID_INPUT" };
const businessRefusal = { error: "The task update was refused", code: "INVALID_INPUT" };
const success = { idempotencyKey: command.idempotencyKey, tasks: [] };

async function submitTask({
  expectedRevision = command.expectedRevision,
  refusal,
  review = "read",
}: {
  expectedRevision?: number;
  refusal?: typeof strictRefusal;
  review?: "read" | "check";
}) {
  const state = temporaryReadPositionState();
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push(await req.json());
      return refusal && requests.length === 1
        ? Response.json(refusal, { status: 400 })
        : Response.json(success);
    },
  });
  const connection = {
    computerId: "acceptance-computer",
    workspaceId: "workspace-1",
    workspaceRoot: state.path,
  };
  const harnessFor = createMessageHarness({
    connection,
    config: { provider: "pi", model: "default", modelProvider: "anthropic", reasoning: "balanced" },
  });
  try {
    const harness = await harnessFor(
      async ({ idempotencyKey, operation }) => ({
        idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [messageRecord(34, "@ada", target)],
        hasOlder: false,
        hasNewer: false,
        ...(operation === "read"
          ? {
              modelSeenUpToSeq: 31,
              consumptionScope: {
                agentId: "agent-a",
                conversationId,
                channelType: "dm" as const,
                target,
              },
            }
          : {}),
      }),
      (request) =>
        defaultAgentTaskHttpClient.execute({
          url: new URL("api/agent/v1/tasks", server.url).toString(),
          agentApiKey: "fixture-agent",
          daemonApiKey: "fixture-daemon",
          request,
        }),
      undefined,
      undefined,
      undefined,
      state.path,
    );
    try {
      await harness.runtime.handleAgentMessage({
        ...taskDelivery(conversationId, 31, `Reply: ${"details ".repeat(50)}`, target),
        agentId: "agent-a",
      });
      const reviewed = await harness.runtime.agentMessage(
        harness.context,
        { operation: review, target, context: harness.context, idempotencyKey: "review-page" },
        harness.apiKey,
      );
      expect(reviewed.messages).toMatchObject([{ sequence: 34 }]);
      const outcome = await harness.runtime
        .agentTask(harness.context, { ...command, expectedRevision }, harness.apiKey)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      return { requests, outcome };
    } finally {
      await harness.runtime.stop();
    }
  } finally {
    await server.stop(true);
    state.remove();
  }
}

function expectScopedFirstRequest(request: unknown, expectedRevision: number) {
  expect(request).toMatchObject({
    ...command,
    expectedRevision,
    consumptionEvidence: [
      expect.objectContaining({ target: { conversationId }, entry: expect.any(Object) }),
    ],
  });
  expect(request).not.toHaveProperty("seenUpToSeq");
  expect(request).not.toHaveProperty("seenExactSeqs");
}

test("a Task POST refused by the old strict schema retries once with the same command and key", async () => {
  const { requests, outcome } = await submitTask({ refusal: strictRefusal });
  expectScopedFirstRequest(requests[0], command.expectedRevision);
  expect(requests.slice(1)).toEqual([command]);
  expect(outcome).toMatchObject({ result: success });
});

test.each([
  {
    kind: "a business refusal",
    expectedRevision: command.expectedRevision,
    refusal: businessRefusal,
  },
  {
    kind: "a bad revision with the same error envelope",
    expectedRevision: -1,
    refusal: strictRefusal,
  },
])(
  "a Task POST propagates $kind without stripping and retrying",
  async ({ expectedRevision, refusal }) => {
    const { requests, outcome } = await submitTask({ expectedRevision, refusal });
    expect(requests).toHaveLength(1);
    expect(outcome).toMatchObject({
      error: { status: 400, code: refusal.code, message: refusal.error },
    });
    expectScopedFirstRequest(requests[0], expectedRevision);
  },
);

test("message check without per-message scope cannot supply evidence to a Task POST", async () => {
  const { requests, outcome } = await submitTask({ review: "check" });
  expect(outcome).toMatchObject({ result: success });
  expect(requests).toEqual([command]);
});
