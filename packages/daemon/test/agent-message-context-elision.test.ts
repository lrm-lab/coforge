import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContexts } from "#src/daemon-runtime/agent-contexts";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";
import { AgentStateDb } from "#src/persistence/agent-state-db";

const ROLE = "[CoForge current channel role: member; coordinator=none]";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(sequence: number) {
  return {
    id: `message-${sequence}`,
    sequence,
    senderKind: "human" as const,
    senderHandle: "ada",
    senderDescription: "Staff engineer",
    target: "#team",
    body: `hello ${sequence}`,
    channelCoordination: ROLE,
    createdAt: "2026-10-30T00:00:00.000Z",
    attachments: [],
  };
}

function setup(stateDb = (root: string, agentId: string) => AgentStateDb.open(root, agentId)) {
  const root = join(tmpdir(), `coforge-context-ops-${crypto.randomUUID()}`);
  roots.push(root);
  const contexts = new AgentContexts((agentId) => stateDb(root, agentId));
  const operations = new AgentMessageOperations({
    connection: { workspaceId: "workspace", computerId: "computer" },
    attention: new AgentMessageAttentionIndex(
      "workspace",
      { session: () => undefined },
      async () => {},
    ),
    isMemoryAgent: () => false,
    contexts,
    inbox: () => {
      throw new Error("not a send");
    },
    transport: {
      agentMessage: async (request) => ({
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [record(1), record(2)],
        hasMore: false,
      }),
    },
    reportFreshnessHold: () => {},
  });
  const check = () =>
    operations.handle(
      "agent-a",
      { idempotencyKey: "check", context: "context", operation: "check" },
      undefined,
      "key",
    );
  const search = () =>
    operations.handle(
      "agent-a",
      { idempotencyKey: "search", context: "context", operation: "search", query: "hello" },
      undefined,
      "key",
    );
  return { contexts, check, search };
}

test("`message check` on a runtime that reports compaction tells a sender and a role line once per context", async () => {
  const { contexts, check } = setup();
  contexts.newContext("agent-a", "claude-code");
  const first = (await check()).messages;
  expect(first.map((m) => m.senderDescription)).toEqual(["Staff engineer", ""]);
  expect(first.map((m) => m.channelCoordination)).toEqual([ROLE, undefined]);
  const second = (await check()).messages;
  expect(second.map((m) => m.senderDescription)).toEqual(["", ""]);
  contexts.newContext("agent-a");
  expect((await check()).messages[0]!.senderDescription).toBe("Staff engineer");
});

test("a runtime that does not report compaction is never left short", async () => {
  const { contexts, check } = setup();
  contexts.newContext("agent-a", "devin");
  for (const _ of [1, 2]) {
    const { messages } = await check();
    expect(messages.map((m) => m.senderDescription)).toEqual(["Staff engineer", "Staff engineer"]);
    expect(messages.map((m) => m.channelCoordination)).toEqual([ROLE, ROLE]);
  }
});

test("search results are never elided, and do not use up what a later read shows", async () => {
  const { contexts, check, search } = setup();
  contexts.newContext("agent-a", "claude-code");
  const found = (await search()).messages;
  expect(found.map((m) => m.senderDescription)).toEqual(["Staff engineer", "Staff engineer"]);
  expect((await check()).messages[0]!.senderDescription).toBe("Staff engineer");
});

test("a ledger that cannot be opened costs neither a launch nor any message text", async () => {
  const { contexts, check } = setup(() => {
    throw new Error("state database is closed");
  });
  expect(() => contexts.newContext("agent-a", "claude-code")).not.toThrow();
  const { messages } = await check();
  expect(messages.map((m) => m.senderDescription)).toEqual(["Staff engineer", "Staff engineer"]);
});
