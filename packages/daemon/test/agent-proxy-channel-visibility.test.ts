import { expect, test } from "bun:test";
import { parseChannelCommand } from "../src/agent-proxy-request-parsers";
import { channelDomainFailure } from "../src/agent-proxy-domain-failures";
import { AgentChannelRequestError } from "../src/connection/agent-channel-request-error";
import { defaultAgentChannelHttpClient } from "../src/connection/agent-http-clients";

/** `channel create --private` and `channel update --public|--private` (task #302) reach the cloud
 * through the local proxy, which copies each field it knows and refuses any other value. */
test("the local proxy carries a channel's visibility on create and update", () => {
  expect(
    parseChannelCommand({
      idempotencyKey: "r-1",
      operation: "create",
      name: "secret",
      visibility: "private",
    }),
  ).toEqual({
    idempotencyKey: "r-1",
    operation: "create",
    target: undefined,
    name: "secret",
    description: undefined,
    visibility: "private",
    user: undefined,
    agent: undefined,
  });
  // A visibility alone is an update.
  expect(
    parseChannelCommand({
      idempotencyKey: "r-2",
      operation: "update",
      target: "#eng",
      visibility: "public",
    }),
  ).toMatchObject({ operation: "update", target: "#eng", visibility: "public" });
});

test("the local proxy refuses a visibility that is neither public nor private", () => {
  const refused = parseChannelCommand({
    idempotencyKey: "r-3",
    operation: "update",
    target: "#eng",
    visibility: "secret",
  });
  expect(refused).toBeInstanceOf(Response);
  expect((refused as Response).status).toBe(400);
});

test("the cloud request carries the visibility the local proxy parsed", async () => {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return Response.json({ channel: { name: "#eng", visibility: "private" } });
    },
  });
  try {
    const command = parseChannelCommand({
      idempotencyKey: "r-4",
      operation: "update",
      target: "#eng",
      visibility: "private",
    });
    if (command instanceof Response) throw new Error("refused");
    await defaultAgentChannelHttpClient.execute({
      url: `http://127.0.0.1:${server.port}/api/agent/v1/channels/%23eng`,
      method: "PATCH",
      request: { ...command, workspaceId: "workspace-1", agentId: "agent-1" },
      agentApiKey: "agent-key",
      daemonApiKey: "daemon-key",
    });
    expect(bodies).toEqual([expect.objectContaining({ visibility: "private" })]);
  } finally {
    await server.stop(true);
  }
});

test("the local proxy accepts announcement string or null on channel update and forwards envelope errors", async () => {
  expect(
    parseChannelCommand({
      idempotencyKey: "r-5",
      operation: "update",
      target: "#eng",
      announcement: "11111111-0000-0000-0000-000000000000",
    }),
  ).toMatchObject({
    operation: "update",
    target: "#eng",
    announcement: "11111111-0000-0000-0000-000000000000",
  });
  expect(
    parseChannelCommand({
      idempotencyKey: "r-6",
      operation: "update",
      target: "@alice",
      announcement: null,
    }),
  ).toMatchObject({
    operation: "update",
    target: "@alice",
    announcement: null,
  });
  const refused = parseChannelCommand({
    idempotencyKey: "r-7",
    operation: "update",
    target: "#eng",
    announcement: 123,
  });
  expect(refused).toBeInstanceOf(Response);
  expect((refused as Response).status).toBe(400);

  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(
        {
          ok: false,
          errorCode: "pinned_artifact_not_in_conversation",
          error: "Artifact not found in #eng.",
        },
        { status: 404 },
      );
    },
  });
  try {
    let caught: unknown;
    try {
      await defaultAgentChannelHttpClient.execute({
        url: `http://127.0.0.1:${server.port}/api/agent/v1/channels/%23eng`,
        method: "PATCH",
        request: {
          idempotencyKey: "r-8",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          operation: "update",
          target: "#eng",
          announcement: "11111111-0000-0000-0000-000000000000",
        },
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentChannelRequestError);
    const response = channelDomainFailure(caught);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({
      ok: false,
      errorCode: "pinned_artifact_not_in_conversation",
      error: "Artifact not found in #eng.",
    });
  } finally {
    await server.stop(true);
  }
});
