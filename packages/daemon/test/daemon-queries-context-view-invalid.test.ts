import { expect, test } from "bun:test";
import {
  encodeAgentContextViewRequest,
  encodeAgentSkillsListRequest,
} from "@lrm/coforge-sdk/internal";
import { DaemonQueries } from "#src/connection/daemon-queries";
import { captureDaemonLogs } from "./log-capture";

/**
 * Every publication on the daemon's channel runs through the query decoders in turn, and a message
 * that belongs to another query — or to another route entirely — fails the context view decode. The
 * daemon logged each of those as "Agent context view request invalid": 255 ERROR lines in three
 * hours on 0.1.28, none of them a real problem (task #34). A decode failure is reported now only
 * when the message itself says it is a context view request.
 */
const scope = { workspaceId: "ws-root", computerId: "cp-1" };
const rpc = async () => undefined;

function invalidRecords(records: readonly { message: readonly unknown[] }[]): string[] {
  return records
    .map((record) => record.message.join(""))
    .filter((text) => text.includes("request invalid"));
}

/** A valid request whose request id starts `Xtv_`, so it names itself one and fails its pattern. */
function requestWithBadId(): Uint8Array {
  const bytes = encodeAgentContextViewRequest({
    protocolMajor: 1,
    requestId: "ctxv_0123456789abcdef",
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    agentId: "agent-1",
    messageId: "msg-1",
    sessionId: "session-1",
    maxBytes: 4096,
  } as never);
  const marker = Buffer.from("ctxv_", "latin1");
  const at = Buffer.from(bytes).indexOf(marker);
  expect(at).toBeGreaterThan(0);
  bytes[at] = 0x58; // `Xtv_` names itself a request and breaks the request-id pattern
  return bytes;
}

test("another query's request does not report an invalid context view request", async () => {
  const skills = encodeAgentSkillsListRequest({
    protocolMajor: 1,
    requestId: "r1",
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    agentId: "agent-1",
    provider: "codex",
  } as never);
  const { result, records } = await captureDaemonLogs(async () => {
    const queries = new DaemonQueries(rpc);
    return queries.receive(skills, scope);
  });
  // The skills query claimed it, so no other query had to look at it.
  expect(result).toBe(true);
  expect(invalidRecords(records)).toEqual([]);
});

test("bytes that name no request type report nothing", async () => {
  // What the context view decoder used to report: a message from another route, unreadable here.
  const foreign = new Uint8Array([0x0a, 0x02, 0x68, 0x69, 0x12, 0x03, 0x61, 0x62, 0x63]);
  const { result, records } = await captureDaemonLogs(async () => {
    const queries = new DaemonQueries(rpc);
    return queries.receive(foreign, scope);
  });
  expect(result).toBe(false);
  expect(invalidRecords(records)).toEqual([]);
});

test("a context view request that fails its own validation is still reported", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    const queries = new DaemonQueries(rpc);
    return queries.receive(requestWithBadId(), scope);
  });
  expect(result).toBe(false);
  expect(invalidRecords(records)).toEqual(["Agent context view request invalid"]);
});
