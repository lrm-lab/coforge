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

test.skipIf(!connectionString)(
  "the backfill fills a forward row's Workspace and sender, and a rerun fills nothing",
  async () => {
    const fixture = await botFixture(db);
    fixtures.push(fixture);
    await fixture.bots.grant(fixture.actor("owner"), fixture.key);
    const bot = await db.appInstallationBot.findFirstOrThrow({
      where: { installationId: fixture.installationId },
      select: { agentId: true },
    });
    // A DM between the viewer and the bot, opened the way the product opens it; the backfill
    // fills the Workspace always and the User id only when the sender is a person, so both a
    // bot-sent row (no user) and a person-sent row (full fill) are pinned.
    const { conversationId } = await new DirectConversations(db).open(
      fixture.workspaceId,
      fixture.people.member.id,
      { agentId: bot.agentId },
    );
    const members = await db.conversationMember.findMany({
      where: { conversationId },
      select: { id: true, agentId: true, userId: true },
    });
    const botMember = members.find((row) => row.agentId === bot.agentId)!;
    const personMember = members.find((row) => row.userId === fixture.people.member.id)!;
    const message = await db.message.create({
      data: {
        workspaceId: fixture.workspaceId,
        conversationId,
        senderMemberId: botMember.id,
        sequence: 1,
        body: "carries a forward",
      },
      select: { id: true },
    });
    await db.messageForward.create({
      data: {
        messageId: message.id,
        position: 0,
        sourceConversationId: conversationId,
        sourceSenderName: "s",
        sourceSenderHandle: "s",
        sourceCreatedAt: new Date(),
        sourceBody: "x",
      },
    });
    const personMessage = await db.message.create({
      data: {
        workspaceId: fixture.workspaceId,
        conversationId,
        senderMemberId: personMember.id,
        sequence: 2,
        body: "person forwards",
      },
      select: { id: true },
    });
    await db.messageForward.create({
      data: {
        messageId: personMessage.id,
        position: 0,
        sourceConversationId: conversationId,
        sourceSenderName: "s",
        sourceSenderHandle: "s",
        sourceCreatedAt: new Date(),
        sourceBody: "x",
      },
    });

    const summary = await backfillForwardSenders({ db, dryRun: false });
    expect(summary.filled).toBeGreaterThanOrEqual(2);
    const rows = await db.messageForward.findMany({
      where: { messageId: { in: [message.id, personMessage.id] } },
      select: { messageId: true, workspaceId: true, senderUserId: true },
    });
    const byMessage = new Map(rows.map((row) => [row.messageId, row]));
    expect(byMessage.get(message.id)).toMatchObject({ workspaceId: fixture.workspaceId });
    expect(byMessage.get(personMessage.id)).toMatchObject({
      workspaceId: fixture.workspaceId,
      senderUserId: fixture.people.member.id,
    });
    // Repeatable: a rerun finds these rows already filled (its WHERE is the rows still missing
    // the columns); rows other tests left behind may still scan, so only this row set is pinned.
    await backfillForwardSenders({ db, dryRun: false });
    const rerunRows = await db.messageForward.findMany({
      where: { messageId: { in: [message.id, personMessage.id] } },
      select: { workspaceId: true, senderUserId: true },
    });
    expect(rerunRows.every((row) => row.workspaceId === fixture.workspaceId)).toBe(true);
  },
);
