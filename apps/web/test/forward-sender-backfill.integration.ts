import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { backfillForwardSenders } from "#src/server/apps/forward-sender-backfill.server";
import { botFixture } from "./app-bots-fixture";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";

/**
 * Release two of task #78: the batched backfill fills `message_forwards.workspaceId` and
 * `senderUserId` for rows a pre-#78 instance wrote without the columns — from the carrying
 * message's Workspace and its sender's member row's User id — and is repeatable, so a rolling
 * deploy's stragglers are caught on the next run. Skipped unless a local PostgreSQL is set.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
const fixtures: Awaited<ReturnType<typeof botFixture>>[] = [];
afterAll(async () => {
  for (const fixture of fixtures) await fixture.cleanup();
  await db.$disconnect();
});

/** A Workspace with a person and a bot sharing a DM — the smallest seat a forward row needs. */
async function forwardSeat() {
  const fixture = await botFixture(db);
  fixtures.push(fixture);
  await fixture.bots.grant(fixture.actor("owner"), fixture.key);
  const bot = await db.appInstallationBot.findFirstOrThrow({
    where: { installationId: fixture.installationId },
    select: { agentId: true },
  });
  const { conversationId } = await new DirectConversations(db).open(
    fixture.workspaceId,
    fixture.people.member.id,
    { agentId: bot.agentId },
  );
  const members = await db.conversationMember.findMany({
    where: { conversationId },
    select: { id: true, agentId: true, userId: true },
  });
  return {
    fixture,
    conversationId,
    botMember: members.find((row) => row.agentId === bot.agentId)!,
    personMember: members.find((row) => row.userId === fixture.people.member.id)!,
  };
}

/** A carrying message and one forward row on it, written without the release-two columns. */
async function seedForward(
  seat: Awaited<ReturnType<typeof forwardSeat>>,
  sequence: number,
  senderMemberId = seat.personMember.id,
) {
  const message = await db.message.create({
    data: {
      workspaceId: seat.fixture.workspaceId,
      conversationId: seat.conversationId,
      senderMemberId,
      sequence,
      body: "carries a forward",
    },
    select: { id: true },
  });
  await db.messageForward.create({
    data: {
      messageId: message.id,
      position: 0,
      sourceConversationId: seat.conversationId,
      sourceSenderName: "s",
      sourceSenderHandle: "s",
      sourceCreatedAt: new Date(),
      sourceBody: "x",
    },
  });
  return message.id;
}

test.skipIf(!connectionString)(
  "the backfill fills a forward row's Workspace and sender, and a rerun fills nothing",
  async () => {
    const seat = await forwardSeat();
    // The backfill fills the Workspace always and the User id only when the sender is a person,
    // so both a bot-sent row (no user) and a person-sent row (full fill) are pinned.
    const botMessageId = await seedForward(seat, 1, seat.botMember.id);
    const personMessageId = await seedForward(seat, 2);

    const summary = await backfillForwardSenders({ db, dryRun: false });
    expect(summary.filled).toBeGreaterThanOrEqual(2);
    const rows = await db.messageForward.findMany({
      where: { messageId: { in: [botMessageId, personMessageId] } },
      select: { messageId: true, workspaceId: true, senderUserId: true },
    });
    const byMessage = new Map(rows.map((row) => [row.messageId, row]));
    expect(byMessage.get(botMessageId)).toMatchObject({
      workspaceId: seat.fixture.workspaceId,
      senderUserId: null,
    });
    expect(byMessage.get(personMessageId)).toMatchObject({
      workspaceId: seat.fixture.workspaceId,
      senderUserId: seat.fixture.people.member.id,
    });
    // Repeatable: a rerun finds these rows already filled (its WHERE is the rows still missing
    // the columns); rows other tests left behind may still scan, so only this row set is pinned.
    await backfillForwardSenders({ db, dryRun: false });
    const rerunRows = await db.messageForward.findMany({
      where: { messageId: { in: [botMessageId, personMessageId] } },
      select: { workspaceId: true, senderUserId: true },
    });
    expect(rerunRows.every((row) => row.workspaceId === seat.fixture.workspaceId)).toBe(true);
  },
);

test.skipIf(!connectionString)(
  "a dry run over more missing rows than one batch ends and counts what it would fill",
  async () => {
    const seat = await forwardSeat();
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await seedForward(seat, sequence);
    }
    // Three missing rows against a batch of two: without the keyset cursor the run re-reads the
    // same first batch forever (a dry run writes nothing, so nothing ever leaves the WHERE).
    const summary = await backfillForwardSenders({ db, dryRun: true, batchSize: 2 });
    expect(summary.batches).toBeGreaterThanOrEqual(2);
    expect(summary.scanned).toBeGreaterThanOrEqual(3);
    expect(summary.filled).toBeGreaterThanOrEqual(3);
    expect(summary.lastMessageId).not.toBeNull();
    const stillMissing = await db.messageForward.count({
      where: { sourceConversationId: seat.conversationId, workspaceId: null },
    });
    expect(stillMissing).toBe(3);
  },
);

test.skipIf(!connectionString)(
  "an apply run steps over a forward row whose message is gone and reports it skipped",
  async () => {
    const seat = await forwardSeat();
    const messageId = await seedForward(seat, 1);
    // The carrying message's cascade makes a stored orphan impossible through the product; the
    // row stands in for the race where the message read misses a row the scan just saw.
    const orphanMessageId = crypto.randomUUID();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.messageForward.create({
        data: {
          messageId: orphanMessageId,
          position: 0,
          sourceConversationId: seat.conversationId,
          sourceSenderName: "s",
          sourceSenderHandle: "s",
          sourceCreatedAt: new Date(),
          sourceBody: "x",
        },
      });
    });
    try {
      const summary = await backfillForwardSenders({ db, dryRun: false, batchSize: 2 });
      expect(summary.skipped).toBeGreaterThanOrEqual(1);
      const orphan = await db.messageForward.findUnique({
        where: { messageId_position: { messageId: orphanMessageId, position: 0 } },
        select: { workspaceId: true },
      });
      expect(orphan?.workspaceId).toBeNull();
      const filled = await db.messageForward.findUnique({
        where: { messageId_position: { messageId, position: 0 } },
        select: { workspaceId: true, senderUserId: true },
      });
      expect(filled).toMatchObject({
        workspaceId: seat.fixture.workspaceId,
        senderUserId: seat.fixture.people.member.id,
      });
      // Resuming after the run's last id scans nothing: every missing row sits at or before it.
      const resumed = await backfillForwardSenders({
        db,
        dryRun: true,
        afterMessageId: summary.lastMessageId!,
      });
      expect(resumed.scanned).toBe(0);
    } finally {
      await db.messageForward.deleteMany({ where: { messageId: orphanMessageId } });
    }
  },
);
