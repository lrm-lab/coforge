import { expect, test } from "bun:test";
import { AGENT_READ_PROTOCOL, type AgentReadRequest } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "../src/local-client";
import { run } from "../src/command-run";
import type { MessageTransport } from "../src/message-transport";

const page = "header.signature";
const messages = ["COMPLETE_FIRST", "SECOND_START\nSECOND_MIDDLE\nSECOND_END"].map(
  (body, index) => ({
    id: `message-${index + 1}`,
    sequence: index + 1,
    target: "#general:#7",
    senderKind: "agent",
    senderHandle: "sender",
    createdAt: "2026-11-27T13:00:00Z",
    body,
  }),
);
const checkpoints = messages.map(({ id, sequence }) => ({
  index: sequence,
  through: sequence,
  messageId: id,
  proof: "A".repeat(43),
}));

function transport(response: unknown) {
  const requests: AgentReadRequest[] = [];
  const port: Pick<MessageTransport, "readConfirmation"> = {
    readConfirmation: async (request) => {
      requests.push(request);
      return response;
    },
  };
  return { requests, port: port as MessageTransport };
}

test("task read prints each checkpoint after the complete message, and next read only confirms what was supplied", async () => {
  const cloud = transport({
    protocol: AGENT_READ_PROTOCOL,
    readThrough: 0,
    window: { messages, moreUnread: true },
    receipt: { page, checkpoints },
  });
  const output = String(
    await run(["task", "read", "#general:#7", "--unread", "--confirm-delivery"], cloud.port),
  );
  const first = JSON.stringify(checkpoints[0]);
  const second = JSON.stringify(checkpoints[1]);
  expect(output.indexOf(first)).toBeGreaterThan(output.indexOf("COMPLETE_FIRST"));
  expect(output.indexOf("SECOND_START")).toBeGreaterThan(output.indexOf(first));
  expect(output.indexOf(second)).toBeGreaterThan(output.indexOf("SECOND_END"));
  const delivered = output.slice(0, output.indexOf("SECOND_MIDDLE"));
  expect(delivered).toContain(first);
  expect(delivered).not.toContain(second);

  const confirm = { page, checkpoints: [checkpoints[0]!] };
  await run(
    ["message", "read", "--target", "#general", "--unread", "--confirm", JSON.stringify(confirm)],
    cloud.port,
  );
  expect(cloud.requests[1]).toEqual({
    operation: "page",
    body: { source: { kind: "message", target: "#general" }, window: { unread: true }, confirm },
  });
});

test("new command refuses a legacy response without calling the legacy read path", async () => {
  const cloud = transport({ messages });
  await expect(
    run(["message", "read", "--target", "#general", "--confirm-delivery"], cloud.port),
  ).rejects.toMatchObject({ code: "READ_CONFIRMATION_UNAVAILABLE" });
  expect(cloud.requests).toHaveLength(1);
});

test("an old proxy gets one request for the new route and no legacy read", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const local = connectLocal("", `sfp_${"a".repeat(43)}`, server.url.href, "");
    await expect(
      run(["message", "read", "--target", "#general", "--confirm-delivery"], local),
    ).rejects.toMatchObject({ code: "READ_CONFIRMATION_UNAVAILABLE" });
    expect(paths).toEqual(["/api/agent/v1/reads/page"]);
  } finally {
    await server.stop(true);
  }
});

test("a middle omission can retain a checkpoint without triggering consumption", async () => {
  const cloud = transport({
    protocol: AGENT_READ_PROTOCOL,
    readThrough: 0,
    window: { messages },
    receipt: { page, checkpoints },
  });
  const output = String(
    await run(["task", "read", "#general:#7", "--confirm-delivery"], cloud.port),
  );
  const delivered = output.replace("SECOND_MIDDLE", "[host omitted content]");
  expect(delivered).toContain(JSON.stringify(checkpoints[1]));
  expect(delivered).not.toContain("SECOND_MIDDLE");
  expect(cloud.requests.map(({ operation }) => operation)).toEqual(["page"]);
});
