import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
/** Run explicitly against the disposable PostgreSQL database after migrate deploy. */
import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaMemoryDispositionStore } from "#src/server/db/repositories/memory-disposition.repositories.server";
import { createMemoryDispositions } from "#src/server/workspace-memory/memory-dispositions.server";
import { createMemoryDispositionTool } from "@coforge/agent";
import { handleMemoryDispositionHttp } from "#src/server/workspace-memory/memory-disposition-http.server";

const connectionString = Bun.env.MEMORY_DISPOSITION_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "MEMORY_DISPOSITION_TEST_DATABASE_URL must name a disposable PostgreSQL database",
  );
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const otherDb = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const workspace = await db.workspace.create({
  data: { slug: `receipt-${Date.now()}`, name: "Receipt integration" },
});
const channel = await db.conversation.create({
  data: { workspaceId: workspace.id, channelName: "receipt-test" },
});
const owner = await db.user.create({
  data: { username: `receipt-owner-${Date.now()}`, displayName: "Receipt owner" },
});
const [target, memory, observer] = await Promise.all(
  ["task", "memory", "observer"].map((name) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name,
        displayName: name,
        ownerId: owner.id,
        runtimeConfig: {},
      },
    }),
  ),
);
if (!target || !memory || !observer) throw new Error("Fixture Agents missing");
const targetAgentId = target.id;
const memoryAgentId = memory.id;
await db.conversationMember.createMany({
  data: [target, memory, observer].map((agent) => ({
    workspaceId: workspace.id,
    conversationId: channel.id,
    agentId: agent.id,
  })),
});
const conversations = new PrismaDirectConversationRepository(db);
const sources = ["a", "b"].map((citationId) => ({
  kind: "openviking" as const,
  citationId,
  workspaceId: workspace.id,
  accountId: "account",
  uri: `viking://resources/${citationId}`,
  matchedLevel: "L2" as const,
}));
const store = new PrismaMemoryDispositionStore(db);
let sequence = 0;
async function delivered() {
  const operationId = `operation-${++sequence}`;
  const input = {
    workspaceId: workspace.id,
    operationId,
    targetAgentId,
    memoryAgentId,
    conversationId: channel.id,
    body: "Verify constraints",
    citations: sources,
    ttlMilliseconds: 300_000,
  };
  const hint = await store.prepare(input);
  await conversations.sendAgentMessage(
    channel.id,
    memoryAgentId,
    "@task " + input.body,
    undefined,
    undefined,
    [{ type: "agent", id: targetAgentId, name: "task" }],
    hint.hint_id,
  );
  return { hint, input };
}
function service(client = db, denied = new Set<string>()) {
  return createMemoryDispositions({
    store: new PrismaMemoryDispositionStore(client),
    async isMemoryAgent() {
      return false;
    },
    async canReadSource(_w, _a, source) {
      return !denied.has(source.citationId);
    },
  });
}
afterAll(async () => {
  await db.workspace.delete({ where: { id: workspace.id } });
  await db.user.delete({ where: { id: owner.id } });
  await Promise.all([db.$disconnect(), otherDb.$disconnect()]);
});

test("native tool through HTTP persists defer and reject history with per-source roles", async () => {
  const { hint } = await delivered();
  const receipt = service();
  const tool = createMemoryDispositionTool({
    async post(_path, body) {
      const response = await handleMemoryDispositionHttp({
        db,
        workspaceId: workspace.id,
        agentId: targetAgentId,
        body,
        service: receipt,
      });
      expect(response.status).toBe(200);
      return response.json();
    },
  });
  const submit = (decision: "defer" | "reject") =>
    tool.execute(
      "call",
      {
        hint_id: hint.hint_id,
        decision,
        reason: "pending verification",
        intended_action_refs: ["future-search"],
      },
      undefined,
      undefined,
      undefined as never,
    );
  await submit("defer");
  await submit("reject");
  await submit("reject");
  const history = await db.memoryDispositionEvent.findMany({
    where: { hintId: hint.hint_id },
    orderBy: { sequence: "asc" },
    include: { citations: true },
  });
  expect(history.map((row) => row.decision)).toEqual(["defer", "reject"]);
  expect(history.map((row) => row.citations.map((citation) => citation.role))).toEqual([
    ["considered", "considered"],
    ["rejected", "rejected"],
  ]);
  expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(sequence);
});

test("two separate PostgreSQL clients serialize conflicting terminal receipts", async () => {
  const { hint } = await delivered();
  const request = { hint_id: hint.hint_id, reason: "candidate applicability" };
  const results = await Promise.all([
    service().submit(workspace.id, targetAgentId, { ...request, decision: "adopt" }),
    service(otherDb).submit(workspace.id, targetAgentId, {
      ...request,
      hint_id: hint.hint_id.toUpperCase(),
      decision: "reject",
    }),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok && result.error.code === "terminal")).toHaveLength(
    1,
  );
  expect(await db.memoryDispositionEvent.count({ where: { hintId: hint.hint_id } })).toBe(1);
});

test("Hint replay preserves id, expiry and frozen provenance; ACL changes affect only new citations", async () => {
  const { hint, input } = await delivered();
  const before = await db.memoryHintRecord.findUniqueOrThrow({ where: { id: hint.hint_id } });
  expect(await store.prepare(input)).toEqual(hint);
  await conversations.sendAgentMessage(
    channel.id,
    memoryAgentId,
    "@task " + input.body,
    undefined,
    undefined,
    [{ type: "agent", id: targetAgentId, name: "task" }],
    hint.hint_id,
  );
  const after = await db.memoryHintRecord.findUniqueOrThrow({ where: { id: hint.hint_id } });
  expect(after.expiresAt).toEqual(before.expiresAt);
  const denied = new Set(["a"]);
  const result = await service(db, denied).submit(workspace.id, targetAgentId, {
    hint_id: hint.hint_id,
    decision: "adopt",
    reason: "one source still visible",
  });
  expect(result.ok && result.record.skipped_source_refs).toEqual(["a"]);
  const event = await db.memoryDispositionEvent.findFirstOrThrow({
    where: { hintId: hint.hint_id },
    include: { citations: true },
  });
  expect(event.citations.map((citation) => citation.citationId)).toEqual(["b"]);
  await expect(store.prepare({ ...input, body: "changed" })).rejects.toThrow("replay conflict");
});

test("recipient-only metadata survives task reads and pending delivery replay", async () => {
  const { hint } = await delivered();
  const recovery = await conversations.readAgentRecoveryContext(workspace.id, targetAgentId);
  expect(
    recovery.resumeMessages.some((message) => message.memoryHint?.hint_id === hint.hint_id),
  ).toBe(true);
  const taskMessages = await conversations.readMessages(
    workspace.id,
    targetAgentId,
    "#receipt-test",
  );
  expect(taskMessages.some((message) => message.memoryHint?.hint_id === hint.hint_id)).toBe(true);
  const observerMessages = await conversations.readMessages(
    workspace.id,
    observer.id,
    "#receipt-test",
  );
  expect(observerMessages.every((message) => !message.memoryHint)).toBe(true);
  const pending = await conversations.readPendingAgentDeliveries(workspace.id, targetAgentId);
  expect(pending.some((message) => message.memoryHint?.hint_id === hint.hint_id)).toBe(true);
});

test("concurrent Hint publication creates one message and one exposure", async () => {
  const hint = await store.prepare({
    workspaceId: workspace.id,
    operationId: "concurrent-publish",
    targetAgentId,
    memoryAgentId,
    conversationId: channel.id,
    body: "Verify constraints",
    citations: sources,
    ttlMilliseconds: 300_000,
  });
  const publish = (client: PrismaClient) =>
    new PrismaDirectConversationRepository(client).sendAgentMessage(
      channel.id,
      memoryAgentId,
      "@task Verify constraints",
      undefined,
      undefined,
      [{ type: "agent", id: targetAgentId, name: "task" }],
      hint.hint_id,
    );
  const before = await db.message.count({ where: { conversationId: channel.id } });
  const [first, second] = await Promise.all([publish(db), publish(otherDb)]);
  expect(first.id).toBe(second.id);
  expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(before + 1);
});

test("an ACL outage appends nothing; leaving the channel retains receipt rights", async () => {
  const { hint } = await delivered();
  const request = { hint_id: hint.hint_id, decision: "adopt", reason: "constraints verified" };
  const unavailable = createMemoryDispositions({
    store,
    async isMemoryAgent() {
      return false;
    },
    async canReadSource(_w, _a, source) {
      if (source.citationId === "b") throw new Error("upstream unavailable");
      return true;
    },
  });
  await expect(unavailable.submit(workspace.id, targetAgentId, request)).rejects.toThrow(
    "upstream unavailable",
  );
  expect(await db.memoryDispositionEvent.count({ where: { hintId: hint.hint_id } })).toBe(0);
  await db.conversationMember.updateMany({
    where: { conversationId: channel.id, agentId: targetAgentId },
    data: { leftAt: new Date() },
  });
  try {
    expect((await service().submit(workspace.id, targetAgentId, request)).ok).toBe(true);
  } finally {
    await db.conversationMember.updateMany({
      where: { conversationId: channel.id, agentId: targetAgentId },
      data: { leftAt: null },
    });
  }
});
