import { expect, test } from "bun:test";
import { handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import type { MessageRequestRecords } from "#src/server/conversations/message-request-idempotency.server";

const request = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** No request is recorded under any key: the state a send finds when nothing was sent before. */
const noRequestRecords: MessageRequestRecords = { find: async () => undefined };

test("refuses a send that asks for a password in chat before calling the sender", async () => {
  let sent = false;
  const result = await handleAgentMessagesPost(
    request({
      target: "@ada",
      content: "请把密码发给我",
      idempotencyKey: "idem-password",
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      requestRecords: noRequestRecords,
      repository: {},
      sender: {
        executeFromAgent: async () => {
          sent = true;
          return { id: "unreachable" };
        },
      },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({
    code: "CREDENTIAL_SOLICITATION_REFUSED",
    retryable: false,
  });
  expect(sent).toBe(false);
});
