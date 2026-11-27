import { expect, test } from "bun:test";
import { AGENT_READ_PROTOCOL, type AgentReadRequest } from "@lrm/coforge-sdk/agent";
import { run } from "@lrm/coforge";
import { connectLocal } from "@lrm/coforge/local-client";
import { startAgentProxy } from "#src/agent-proxy";
import { assembleAgentRequests } from "#src/daemon-runtime/agent-request-forwarder";
import { settleAgentReadConfirmation } from "#src/daemon-runtime/agent-read-confirmation";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

const target = "#coforge:#100";
const scope = {
  agentId: "agent-1",
  conversationId: "conversation-1",
  target,
  channelType: "thread",
} as const;

test("fetching a page settles nothing until Web confirms the actually delivered prefix", async () => {
  const attention = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  for (const sequence of [1, 2, 3])
    await attention.receive({ ...delivery(String(sequence)), target, sequence });
  const pending = () =>
    attention.pendingWindow("agent-1", target, 3).map(({ delivery }) => delivery.sequence);
  const page = () =>
    Response.json({
      protocol: AGENT_READ_PROTOCOL,
      window: {
        messages: [
          { id: "message-1", sequence: 1 },
          { id: "message-2", sequence: 2 },
        ],
      },
      readThrough: 0,
    });

  await settleAgentReadConfirmation(attention, "agent-1", page());
  expect(pending()).toEqual([1, 2, 3]);

  await settleAgentReadConfirmation(
    attention,
    "agent-1",
    Response.json({
      protocol: AGENT_READ_PROTOCOL,
      confirmation: { scope: { ...scope, agentId: "another-agent" }, readThrough: 2 },
    }),
  );
  expect(pending()).toEqual([1, 2, 3]);

  const confirmed = await settleAgentReadConfirmation(
    attention,
    "agent-1",
    Response.json({
      protocol: AGENT_READ_PROTOCOL,
      confirmation: { scope, readThrough: 1 },
    }),
  );
  expect(await confirmed.json()).toMatchObject({ confirmation: { readThrough: 1 } });
  expect(pending()).toEqual([2, 3]);
  expect(attention.hasSeen("agent-1", target, 2, "conversation-1")).toBe(false);
});

test("CLI and proxy carry an explicit prefix and the next page retains the unseen suffix", async () => {
  const attention = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  for (const sequence of [1, 2, 3])
    await attention.receive({ ...delivery(String(sequence)), target, sequence });

  const pending = () =>
    attention.pendingWindow("agent-1", target, 3).map(({ delivery }) => delivery.sequence);
  const sample = ["DELIVERED_FIRST", "UNSEEN_START\nUNSEEN_MIDDLE\nUNSEEN_END", "NEXT_PAGE"].map(
    (body, index) => ({
      id: `message-${index + 1}`,
      sequence: index + 1,
      target,
      senderHandle: "writer",
      senderKind: "agent",
      createdAt: "2026-11-27T14:30:00Z",
      body,
    }),
  );
  let cursor = 0;
  const requests: AgentReadRequest[] = [];
  const forward = assembleAgentRequests({
    messages: { messageAttention: attention },
    connection: { workspaceId: "workspace-1" },
    authorizedAgent: (context) => context,
    transport: () => ({
      agentReadConfirmation: async (request) => {
        requests.push(request);
        if (request.operation === "confirm")
          throw new Error("Expected confirmation with next read");
        const confirmed = request.body.confirm?.checkpoints.at(-1)?.through;
        if (confirmed !== undefined) cursor = confirmed;
        const messages = sample.filter((message) => message.sequence > cursor).slice(0, 2);
        return Response.json({
          protocol: AGENT_READ_PROTOCOL,
          window: { messages },
          readThrough: cursor,
          receipt: {
            page: "test.page",
            checkpoints: messages.map(({ id, sequence }, index) => ({
              index: index + 1,
              through: sequence,
              messageId: id,
              proof: "A".repeat(43),
            })),
          },
          ...(confirmed !== undefined ? { confirmation: { scope, readThrough: cursor } } : {}),
        });
      },
    }),
  });
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (id) => id,
      agentReadConfirmation: (...args) => forward.agentReadConfirmation(...args),
    },
  });
  try {
    const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
    const cli = connectLocal("", token, proxy.url, "");
    const args = ["task", "read", target, "--unread", "--limit", "2", "--confirm-delivery"];
    const original = String(await run(args, cli));
    const visible = original.slice(0, original.indexOf("UNSEEN_START"));
    expect(visible).toContain("DELIVERED_FIRST");
    expect(visible).not.toContain("UNSEEN_END");
    expect(cursor).toBe(0);
    expect(pending()).toEqual([1, 2, 3]);
    const checkpoint = visible.split("\n").find((line) => line.startsWith("Read checkpoint: "));
    expect(checkpoint).toBeDefined();
    const confirm = {
      page: "test.page",
      checkpoints: [JSON.parse(checkpoint!.slice("Read checkpoint: ".length))],
    };
    const next = String(await run([...args, "--confirm", JSON.stringify(confirm)], cli));
    expect(next).toContain("UNSEEN_MIDDLE");
    expect(next).toContain("NEXT_PAGE");
    expect(next).not.toContain("DELIVERED_FIRST");
    expect(cursor).toBe(1);
    expect(pending()).toEqual([2, 3]);
    expect(requests.map((request) => request.operation)).toEqual(["page", "page"]);
  } finally {
    proxy.close();
  }
});
