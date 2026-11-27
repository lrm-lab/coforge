import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLocal } from "@lrm/coforge/local-client";
import { startAgentProxy } from "#src/agent-proxy";
import { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";
import { AgentRequestForwarder } from "#src/daemon-runtime/agent-request-forwarder";
import { AgentContextLedger } from "#src/persistence/agent-context-ledger";
import { AgentStateDb } from "#src/persistence/agent-state-db";

function taskReadLedger() {
  const root = mkdtempSync(join(tmpdir(), "coforge-task-read-ledger-"));
  const stateDb = AgentStateDb.open(root, "agent-a");
  return {
    ledger: new AgentContextLedger(stateDb.database),
    [Symbol.dispose]() {
      stateDb.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("task reads elide repeated sender introductions in the Agent context", async () => {
  using context = taskReadLedger();
  const forwarder = new AgentRequestForwarder({
    connection: { workspaceId: "workspace" },
    authorizedAgent: () => "agent-a",
    contexts: { ledger: () => context.ledger },
    transport: {
      agentTaskConversation: async () =>
        Response.json({
          messages: [
            {
              id: "m1",
              sequence: 1,
              senderKind: "agent",
              senderHandle: "scout",
              senderDescription: "A scouting Agent",
              target: "#general:#7",
              body: "one",
              createdAt: new Date().toISOString(),
              attachments: [],
            },
            {
              id: "m2",
              sequence: 2,
              senderKind: "agent",
              senderHandle: "scout",
              senderDescription: "A scouting Agent",
              target: "#general:#7",
              body: "two",
              createdAt: new Date().toISOString(),
              attachments: [],
            },
          ],
        }),
    },
  });

  const response = await forwarder.agentTaskConversation(
    "context",
    { route: "read", query: { channel: "#general", task_number: "7" } },
    "key",
  );
  const body = (await response.json()) as { messages: { senderDescription: string }[] };
  expect(body.messages.map((message) => message.senderDescription)).toEqual([
    "A scouting Agent",
    "",
  ]);
});

test("a rewritten task read drops the upstream content-length and content-encoding", async () => {
  using context = taskReadLedger();
  context.ledger.claim("sender", "agent:scout", "A scouting Agent");
  const forwarder = new AgentRequestForwarder({
    connection: { workspaceId: "workspace" },
    authorizedAgent: () => "agent-a",
    contexts: { ledger: () => context.ledger },
    transport: {
      agentTaskConversation: async () =>
        // fetch decodes the wire body but leaves the wire headers: the compressed byte count
        // and encoding describe neither the rewritten JSON nor its length.
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "m1",
                sequence: 1,
                senderKind: "agent",
                senderHandle: "scout",
                senderDescription: "A scouting Agent",
                target: "#general:#7",
                body: "one",
                createdAt: new Date().toISOString(),
                attachments: [],
              },
              {
                id: "m2",
                sequence: 2,
                senderKind: "agent",
                senderHandle: "scout",
                senderDescription: "A scouting Agent",
                target: "#general:#7",
                body: "two",
                createdAt: new Date().toISOString(),
                attachments: [],
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": "12",
              "content-encoding": "gzip",
            },
          },
        ),
    },
  });

  const response = await forwarder.agentTaskConversation(
    "context",
    { route: "read", query: { channel: "#general", task_number: "7" } },
    "key",
  );
  const body = (await response.json()) as { messages: { senderDescription: string }[] };
  expect(body.messages).toHaveLength(2);
  expect(response.headers.get("content-length")).toBeNull();
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("content-type")).toBe("application/json");
});

test("a task draft survives reopening, uses the held task ID and reuses the send key", async () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-task-reply-draft-"));
  let db = AgentStateDb.open(root, "agent-a");
  let inbox = AgentInboxStateMachine.open(db);
  const requests: unknown[] = [];
  const board = { channel: "#general", task_number: 7 };
  const content = { content: "Save my reply", idempotencyKey: "original", attachmentIds: ["file"] };
  const held = {
    state: "held",
    taskId: "stable-task",
    reason: "exact_target_pending",
    newMessageCount: 1,
    omittedMessageCount: 0,
    heldMessages: [{ sequence: 1, body: "unread" }],
  };
  const forwarder = new AgentRequestForwarder({
    connection: { workspaceId: "workspace" },
    authorizedAgent: () => "agent-a",
    taskReplyInbox: () => inbox,
    transport: {
      agentTaskConversation: async ({ body }) => {
        requests.push(body);
        if (requests.length === 2)
          return Response.json({ code: "NOT_FOUND", error: "not found" }, { status: 404 });
        if (requests.length < 4) return Response.json(held);
        return Response.json({ messageId: "sent", sequence: 2 });
      },
    },
  });
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (id) => id,
      agentTaskConversation: (...args) => forwarder.agentTaskConversation(...args),
    },
  });
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const cli = connectLocal("", token, proxy.url, "");
  const reply = (body: Record<string, unknown>) => cli.taskConversation({ route: "reply", body });
  try {
    expect(await reply({ ...board, ...content, holdIfUnread: true })).toEqual(held);
    db.close();
    db = AgentStateDb.open(root, "agent-a");
    inbox = AgentInboxStateMachine.open(db);
    await expect(reply({ ...board, sendDraft: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await reply({ ...board, sendDraft: true })).toEqual(held);
    expect(await reply({ ...board, sendDraft: true, anyway: true })).toMatchObject({
      messageId: "sent",
    });
    expect(requests.slice(1)).toEqual(
      [false, false, true].map((anyway) => ({
        channel: "#general",
        task_number: 0,
        resume: { number: 7, taskId: "stable-task", anyway },
        ...content,
      })),
    );
    await expect(reply({ ...board, sendDraft: true })).rejects.toMatchObject({
      code: "SEND_DRAFT_NOT_FOUND",
    });
    expect(requests).toHaveLength(4);
  } finally {
    proxy.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy task replies and reconciliation do not open the draft store", async () => {
  const bodies: unknown[] = [];
  const forwarder = new AgentRequestForwarder({
    connection: { workspaceId: "workspace" },
    authorizedAgent: () => "agent-a",
    taskReplyInbox: () => {
      throw new Error("draft store unavailable");
    },
    transport: {
      agentTaskConversation: async ({ body }) => {
        bodies.push(body);
        return Response.json({ messageId: "sent", sequence: 2 });
      },
    },
  });
  const target = { channel: "#general", task_number: 7, idempotencyKey: "k" };
  const requests = [
    { ...target, content: "old client" },
    { ...target, reconcileOnly: true },
  ];
  for (const body of requests)
    expect(
      (await forwarder.agentTaskConversation("context", { route: "reply", body }, "key")).status,
    ).toBe(200);
  expect(bodies).toEqual(requests);
});
