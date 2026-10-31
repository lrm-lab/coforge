import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import type { MessageRequestRecords } from "#src/server/conversations/message-request-idempotency.server";

const request = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** No request is recorded under any key: the state a send finds when nothing was sent before. */
const noRequestRecords: MessageRequestRecords = { find: async () => undefined };

const post = (thrown: Error, target: string) =>
  handleAgentMessagesPost(
    request({ target, content: "hello" }),
    {
      workspaceId: "workspace-1",
      agentId: "agent-1",
    },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw thrown;
        },
      },
    },
  );

test("a malformed @target answers 400 instead of leaking the raw error", async () => {
  const response = await post(new AppError("INVALID_TARGET"), "@FrankAn");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid message target" });
});

test("an unknown username and a scope outside the Workspace read the same refusal", async () => {
  const response = await post(new AppError("TARGET_NOT_ACCESSIBLE"), "@outsider");
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "target is not accessible",
    code: "TARGET_NOT_ACCESSIBLE",
    retryable: false,
  });
});

test("an empty content is a bad request, before the sender runs", async () => {
  const response = await handleAgentMessagesPost(
    request({ target: "@ada", content: "" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new Error("must not send");
        },
      },
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "target and content are required" });
});
