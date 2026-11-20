import { afterAll, beforeAll, expect, test } from "bun:test";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { draftsHarness, type DraftsHarness } from "./helpers/artifact-drafts-harness";

let h: DraftsHarness;

beforeAll(async () => {
  h = await draftsHarness("notice-inbox");
});
afterAll(() => h.f.cleanup());

test("the bot inbox stops handing back a notice once the artifact is gone", async () => {
  const { AppBotInbox } = await import("#src/server/app-bots/app-bot-inbox.server");
  const artifact = await h.f.make("Inbox gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Inbox gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true, conversationId: true, message: { select: { sequence: true } } },
  });
  const principal = { workspaceId: h.f.workspaceId, agentId: h.f.agents.reader };
  const { listWakeHints } = await import("#src/server/agents/external-wake-hints.server");
  const hinted = async () =>
    (await listWakeHints(h.f.db, principal)).map((hint) => hint.firstPendingMsgId);
  const inbox = new AppBotInbox(h.f.db);
  expect((await inbox.check(principal)).events.map((item) => item.id)).toContain(event.messageId);

  await h.f.db.artifact.update({ where: { id: artifact }, data: { deletedAt: new Date() } });

  expect((await inbox.check(principal)).events.map((item) => item.id)).not.toContain(
    event.messageId,
  );
  expect(await hinted()).not.toContain(event.messageId);
});

test("the wake hint drops the notice in the same step its artifact goes", async () => {
  const { listWakeHints } = await import("#src/server/agents/external-wake-hints.server");
  const artifact = await h.f.make("Hint gate");
  const other = await h.nameOf(h.f.agents.other);
  await h.create(artifact, `Hint gate, see @${other}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.other,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true, conversationId: true },
  });
  const scope = { workspaceId: h.f.workspaceId, agentId: h.f.agents.other };
  const hinted = async () =>
    (await listWakeHints(h.f.db, scope)).map((hint) => hint.firstPendingMsgId);
  expect(await hinted()).toContain(event.messageId);

  await h.f.db.artifact.update({ where: { id: artifact }, data: { deletedAt: new Date() } });

  expect(await hinted()).not.toContain(event.messageId);
});

test("a conversation whose only unread notice is blocked yields no cursor group", async () => {
  const { AppBotInbox } = await import("#src/server/app-bots/app-bot-inbox.server");
  const artifact = await h.f.make("Cursor gate");
  const other = await h.nameOf(h.f.agents.other);
  await h.create(artifact, `Cursor gate, see @${other}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.other,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true, conversationId: true },
  });
  const principal = { workspaceId: h.f.workspaceId, agentId: h.f.agents.other };
  const inbox = new AppBotInbox(h.f.db);
  expect((await inbox.check(principal)).events.map((item) => item.id)).toEqual([event.messageId]);

  await h.f.db.artifact.update({ where: { id: artifact }, data: { deletedAt: new Date() } });

  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pending = (
    await conversations.readPendingAgentDeliveries(h.f.workspaceId, h.f.agents.other)
  ).map((delivery) => delivery.messageId);
  expect(pending).not.toContain(event.messageId);
  expect(
    await h.f.db.systemAgentEvent.count({
      where: {
        message: { conversationId: event.conversationId },
        messageId: { notIn: pending },
      },
    }),
  ).toBe(
    await h.f.db.systemAgentEvent.count({
      where: { message: { conversationId: event.conversationId } },
    }),
  );

  const readThrough = async () =>
    (
      await h.f.db.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_agentId: {
            conversationId: event.conversationId,
            agentId: h.f.agents.other,
          },
        },
        select: { agentReadThroughSequence: true },
      })
    ).agentReadThroughSequence;
  const before = await readThrough();
  const pull = await inbox.check(principal);
  const decoded = JSON.parse(Buffer.from(pull.cursor, "base64url").toString("utf8")) as {
    groups: [conversationId: string, threadRootId: string | null, sequence: number][];
    outside: string[];
  };
  expect(decoded.groups).toEqual([]);
  expect(decoded.outside).toEqual([]);
  await inbox.check(principal, { since: pull.cursor });
  expect(await readThrough()).toBe(before);

  const readable = await h.f.make("Cursor gate next");
  await h.create(readable, `Cursor gate next, see @${other}.`);
  const nextSent = await h.submit(readable);
  if (nextSent.status !== "sent") throw new Error("not sent");
  const nextEvent = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.other,
        externalEventId: `${readable}:${WEB_DRAFT_REVIEW_MARKER}:${nextSent.reviewId}`,
      },
    },
    select: { messageId: true, message: { select: { sequence: true } } },
  });
  const followed = await inbox.check(principal);
  expect(followed.events.map((item) => item.id)).toEqual([nextEvent.messageId]);
  await inbox.check(principal, { since: followed.cursor });
  expect(await readThrough()).toBe(nextEvent.message.sequence);
});

test("an artifact in another workspace leaves its notice unreadable", async () => {
  const artifact = await h.f.make("Foreign gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Foreign gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true },
  });
  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pending = async () =>
    (await conversations.readPendingAgentDeliveries(h.f.workspaceId, h.f.agents.reader)).map(
      (delivery) => delivery.messageId,
    );
  await h.f.db.artifact.update({ where: { id: artifact }, data: { access: "workspace" } });
  expect(await pending()).toContain(event.messageId);

  const foreign = await h.f.db.workspace.create({
    data: { slug: `foreign-${Date.now()}`, name: "Foreign" },
  });
  try {
    await h.f.db.artifact.update({ where: { id: artifact }, data: { workspaceId: foreign.id } });

    expect(await pending()).not.toContain(event.messageId);
  } finally {
    await h.f.db.artifact.delete({ where: { id: artifact } });
    await h.f.db.workspace.delete({ where: { id: foreign.id } });
  }
});
