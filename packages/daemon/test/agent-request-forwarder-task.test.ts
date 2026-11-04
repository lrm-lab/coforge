import { expect, test } from "bun:test";
import { AgentRequestForwarder } from "#src/daemon-runtime/agent-request-forwarder";

test("task reads elide repeated sender introductions in the Agent context", async () => {
  const seen = new Set<string>();
  const forwarder = new AgentRequestForwarder({
    connection: { workspaceId: "workspace" },
    authorizedAgent: () => "agent-a",
    contexts: {
      ledger: () =>
        ({
          claim: (_kind: string, id: string) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          },
          release: () => {},
        }) as never,
    },
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
