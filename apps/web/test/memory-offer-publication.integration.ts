/** Real Message/Hint transactions; no OpenViking or notification network calls. */
import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaMemoryDispositionStore } from "#src/server/db/repositories/memory-disposition.repositories.server";
import { PrismaWorkspaceMemoryCitationStore } from "#src/server/db/repositories/workspace-memory-citation.repositories.server";
import { WorkspaceMemoryCitationKindError } from "#src/server/db/repositories/workspace-memory-errors.server";
import { createMemoryOffers } from "#src/server/workspace-memory/memory-offers";
import { createMemoryCitationBindings } from "#src/server/workspace-memory/memory-citations";
import { createMemoryAgentBudgetLedger } from "#src/server/workspace-memory/memory-agent-budget";
import {
  createMemoryAgentCommands,
  memoryAgentResultToResponse,
  triggerMessageIdFrom,
} from "#src/server/workspace-memory/memory-agent-route";
import { OPENVIKING_AGENT_PROTOCOL, OPENVIKING_TOOL_PROFILE } from "@lrm/coforge-sdk/agent";

const connectionString = Bun.env.MEMORY_DISPOSITION_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "MEMORY_DISPOSITION_TEST_DATABASE_URL must name a disposable PostgreSQL database",
  );
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const workspace = await db.workspace.create({
  data: { slug: `offer-${crypto.randomUUID()}`, name: "Offer recovery" },
});
const owner = await db.user.create({
  data: { username: `offer-${crypto.randomUUID()}`, displayName: "Offer owner" },
});
const [memory, task] = await Promise.all(
  ["memory", "task"].map((name) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name,
        displayName: name,
        runtimeConfig: {},
      },
    }),
  ),
);
if (!memory || !task) throw new Error("Missing fixture Agents");
const memoryAgentId = memory.id;
const targetAgentId = task.id;
const channel = await db.conversation.create({
  data: { workspaceId: workspace.id, channelName: "offers" },
});
await db.conversationMember.createMany({
  data: [memory, task].map((agent) => ({
    workspaceId: workspace.id,
    conversationId: channel.id,
    agentId: agent.id,
  })),
});
const hints = new PrismaMemoryDispositionStore(db);
const citationStore = new PrismaWorkspaceMemoryCitationStore(db);
const conversations = new PrismaDirectConversationRepository(db);
const citations = createMemoryCitationBindings({ openviking: citationStore });
await citations.bindOpenVikingHits(workspace.id, "served", [
  {
    citationId: "ov:a",
    accountId: "account",
    uri: "viking://resources/a",
    contentHash: "hash-a",
    matchedLevel: "L2",
    excerpt: "served evidence",
  },
]);
afterAll(async () => {
  await db.workspace.delete({ where: { id: workspace.id } });
  await db.user.delete({ where: { id: owner.id } });
  await db.$disconnect();
});

function service(
  options: {
    failSave?: boolean;
    failAfterCommit?: boolean;
    failBeforeCommit?: boolean;
    targetUnavailable?: boolean;
  } = {},
) {
  let publisherCalls = 0;
  let targetLookups = 0;
  const budgets = createMemoryAgentBudgetLedger();
  const offers = createMemoryOffers({
    citations,
    offers: {
      getOffer: (w, o) => citationStore.getOffer(w, o),
      async putOffer(input) {
        if (options.failSave) {
          options.failSave = false;
          throw new WorkspaceMemoryCitationKindError();
        }
        return citationStore.putOffer(input);
      },
    },
    hints: {
      find: (w, a, o) => hints.findOffer(w, a, o),
      prepare: (input) => hints.prepare({ ...input, ttlMilliseconds: 300_000 }),
    },
    channels: {
      async isMemoryAgent() {
        return false;
      },
      async isActiveChannelAgent() {
        return true;
      },
    },
    publisher: {
      async publish(input) {
        publisherCalls++;
        if (options.failBeforeCommit) {
          options.failBeforeCommit = false;
          throw new Error("publisher response unknown");
        }
        const saved = await conversations.sendAgentMessage(
          input.conversationId,
          input.memoryAgentId,
          input.body,
          undefined,
          undefined,
          [{ type: "agent", id: targetAgentId, name: "task" }],
          input.memoryHint.hint_id,
        );
        if (options.failAfterCommit) {
          options.failAfterCommit = false;
          throw new Error("commit reply lost");
        }
        return { messageId: saved.id };
      },
    },
  });
  const handler = createMemoryAgentCommands({
    budgets,
    citations,
    offers,
    directory: {
      async isDesignated() {
        return true;
      },
    },
    fence: {
      async resolve() {
        return OPENVIKING_TOOL_PROFILE;
      },
    },
    offerTargets: {
      async resolve() {
        targetLookups++;
        return options.targetUnavailable ? null : { conversationId: channel.id, targetAgentId };
      },
    },
    openviking: {} as never,
  });
  return { handler, budgets, calls: () => ({ publisherCalls, targetLookups }) };
}
function request(
  server: ReturnType<typeof service>,
  operationId: string,
  triggerHeader?: string,
  citationRefs = ["ov:a"],
  body = "Evidence",
) {
  const request = new Request("http://fixture", {
    headers: triggerHeader ? { "x-coforge-trigger-message-id": triggerHeader } : {},
  });
  return server.handler.handle({
    workspaceId: workspace.id,
    agentId: memoryAgentId,
    triggerMessageId: triggerMessageIdFrom(request, operationId),
    command: { protocol: OPENVIKING_AGENT_PROTOCOL, op: "offer", operationId, citationRefs, body },
  });
}
const rows = (operationId: string) =>
  db.memoryHintRecord.findUnique({
    where: { workspaceId_operationId: { workspaceId: workspace.id, operationId } },
  });
const slots = (server: ReturnType<typeof service>, triggerMessageId: string) =>
  server.budgets
    .forTrigger({ workspaceId: workspace.id, agentId: memoryAgentId, triggerMessageId })
    .snapshot().offers;

for (const header of [false, true]) {
  test(`prepublish 400 releases its acquired slot (trigger header=${header})`, async () => {
    const op = `pre-${header}`;
    const server = service();
    const result = await request(server, op, header ? op : undefined, ["unserved"]);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      publication: { phase: "rejected_before_publish" },
    });
    const response = memoryAgentResultToResponse(result);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      operationId: op,
      error: { code: "openviking-citation-ungrounded" },
      publication: { phase: "rejected_before_publish" },
    });
    expect(await rows(op)).toBeNull();
    expect(slots(server, op)).toBe(0);
    expect(await request(server, `${op}-fixed`, header ? op : undefined)).toMatchObject({
      ok: true,
      response: { publication: { phase: "published", messageId: expect.any(String) } },
    });
  });
}

test("postcommit 400 retains its slot; same ID restores the same Message and frozen target", async () => {
  const op = "postcommit-400";
  const server = service({ failSave: true });
  expect(await request(server, op, op)).toMatchObject({
    ok: false,
    status: 400,
    code: "openviking-citation-ungrounded",
    publication: { phase: "published", messageId: expect.any(String) },
  });
  const before = await rows(op);
  expect(before?.messageId).toBeString();
  expect(slots(server, op)).toBe(1);
  expect(await request(server, `${op}-new`, op)).toMatchObject({ ok: false, status: 429 });
  const recovered = service({ targetUnavailable: true });
  expect(await request(recovered, op, op)).toMatchObject({
    ok: true,
    response: {
      duplicate: true,
      messageId: before?.messageId,
      publication: { phase: "published", messageId: before?.messageId },
    },
  });
  expect(recovered.calls()).toEqual({ publisherCalls: 0, targetLookups: 0 });
  expect((await rows(op))?.messageId).toBe(before?.messageId);
  expect(await db.message.count({ where: { id: before!.messageId! } })).toBe(1);
  expect(await citationStore.getOffer(workspace.id, op)).toMatchObject({
    messageId: before?.messageId,
  });
});

for (const loss of ["http", "commit"] as const) {
  test(`same-ID recovery after lost ${loss} response publishes one canonical Message`, async () => {
    const op = `lost-${loss}`;
    const server = service({ failAfterCommit: loss === "commit" });
    // Discard a successful HTTP result, or lose the repository's reply after commit.
    await request(server, op, op);
    const before = await rows(op);
    expect(before?.messageId).toBeString();
    expect(await request(server, `${op}-new`, op)).toMatchObject({ ok: false, status: 429 });
    expect(await request(server, op, op)).toMatchObject({
      ok: true,
      response: { duplicate: true, messageId: before?.messageId },
    });
    expect(server.calls().publisherCalls).toBe(1);
  });
}

test("entering the publisher without proof of commit stays unknown and permits only identical recovery", async () => {
  const server = service({ failBeforeCommit: true });
  const failure = await request(server, "uncertain", "uncertain");
  expect(failure).toMatchObject({ ok: false, status: 503 });
  expect("publication" in failure).toBe(false);
  expect((await rows("uncertain"))?.messageId).toBeNull();
  expect(await request(server, "new-id", "uncertain")).toMatchObject({ ok: false, status: 429 });
  expect(await request(server, "uncertain", "uncertain")).toMatchObject({ ok: true });
});

test("one process admits only one of two concurrent new IDs on the same trigger", async () => {
  const server = service();
  const results = await Promise.all([
    request(server, "parallel-a", "parallel"),
    request(server, "parallel-b", "parallel"),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok && result.status === 429)).toHaveLength(1);
  expect(server.calls().publisherCalls).toBe(1);
});

test("a committed Hint whose Message was deleted cannot republish or prove a prepublish rejection", async () => {
  const server = service();
  await request(server, "deleted-message", "deleted-message");
  const hint = await rows("deleted-message");
  expect(await hints.findOffer(workspace.id, targetAgentId, "deleted-message")).toBeNull();
  await db.message.delete({ where: { id: hint!.messageId! } });
  const result = await request(server, "deleted-message", "deleted-message");
  expect(result.ok).toBe(false);
  expect("publication" in result).toBe(false);
  expect(server.calls().publisherCalls).toBe(1);
});

test("an unknown earlier attempt cannot be refunded by a later prepublish target refusal", async () => {
  const options = { failBeforeCommit: true, targetUnavailable: false };
  const server = service(options);
  const first = await request(server, "unknown-then-refused", "same-trigger");
  expect(first.ok).toBe(false);
  expect("publication" in first).toBe(false);
  // The prepared Hint may belong to a publisher whose outcome was lost.
  // A later request failing before its own publisher says nothing about that attempt.
  options.targetUnavailable = true;
  const second = await request(server, "unknown-then-refused", "same-trigger");
  expect(second.ok).toBe(false);
  expect("publication" in second).toBe(false);
  expect(slots(server, "same-trigger")).toBe(1);
  expect(await request(server, "replacement-id", "same-trigger")).toMatchObject({
    ok: false,
    status: 429,
  });
});
