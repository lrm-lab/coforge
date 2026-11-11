import { expect, test } from "bun:test";
import { encodeAgentContextViewRequest } from "@lrm/coforge-sdk/internal";
import { DaemonQueries } from "#src/connection/daemon-queries";
import { captureDaemonLogs } from "./log-capture";

/**
 * The daemon's channel carries every publication, and each one is offered to the query decoders in
 * turn. Only a message that says it is a context view request is one, so only that one's failure to
 * decode is worth reporting (task #34).
 */
const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

async function reported(bytes: Uint8Array): Promise<{ claimed: boolean; records: string[] }> {
  const { result, records } = await captureDaemonLogs(async () => {
    const queries = new DaemonQueries(async () => {});
    return queries.receive(bytes, scope);
  });
  return {
    claimed: result,
    records: records
      .filter((record) => record.properties.event === "daemon.agent_context_view.request_invalid")
      .map((record) => record.message.join("")),
  };
}

test("bytes that name no context view request are silently another query's business", async () => {
  // A single unreadable byte is no claim of being a context view request: 255 of these used to be
  // reported as invalid requests in three hours, none of them one (task #34).
  expect(await reported(new Uint8Array([0xff]))).toEqual({
    claimed: false,
    records: [],
  });
});

test("a context view request this build cannot read still emits the invalid-request event", async () => {
  const request = encodeAgentContextViewRequest({
    protocolMajor: 1,
    requestId: "ctxv_0123456789abcdef",
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    agentId: "agent-1",
    messageId: "msg-1",
    sessionId: "session-1",
    maxBytes: 4096,
  } as never);
  // A field this build cannot read sits after the request's own type, which is still in the bytes:
  // a malformed request of ours is exactly what the report exists for.
  const unreadable = new Uint8Array([...request, 0xff]);
  expect(await reported(unreadable)).toEqual({
    claimed: false,
    records: ["Agent context view request invalid"],
  });
});
