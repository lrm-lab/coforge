import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
