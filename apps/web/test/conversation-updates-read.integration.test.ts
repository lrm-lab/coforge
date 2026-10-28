import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  browserMessageUpdates,
  mapBrowserMessage,
} from "#src/server/conversations/conversation-history.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

/**
 * The realtime reconciliation read runs on every publication, every visibility change and a
 * safety timer, and most of those bring no message. A read that brings nothing must cost the
 * arrival check alone: Prisma loads each relation of `browserMessageFields` as its own statement
 * and asks for them even when no message matched. The two-step read must still hydrate exactly the
 * row the single relational read did, so the hydrated fields are pinned here too.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `activity-nav-attention-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const createDb = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
    log: [{ emit: "event", level: "query" }],
  });
type QueryLogDb = ReturnType<typeof createDb>;

/** The message relations `browserMessageFields` loads, one statement each when a row matched. */
const MESSAGE_RELATION_TABLES = /"(attachments|message_mentions|message_reactions)"/;
/** The sender relation's tables, which only a matched message loads here. `agents` is left out:
 * `viewerChannel` loads the channel's coordinator Agent on every read, matched or not. */
const SENDER_RELATION_TABLES = /"(conversation_members|users)"/;

function recorder(db: QueryLogDb) {
  const queries: string[] = [];
  let recording = false;
  db.$on("query", (event) => {
    if (recording) queries.push(event.query);
  });
  return {
    async record<T>(run: () => Promise<T>): Promise<{ result: T; queries: string[] }> {
      queries.length = 0;
      recording = true;
      try {
        return { result: await run(), queries: [...queries] };
      } finally {
        recording = false;
      }
    },
  };
}

async function seed(db: QueryLogDb) {
  const handle = crypto.randomUUID().slice(0, 8);
  const viewer = await db.user.create({
    data: { displayName: `updates-viewer-${handle}`, username: `updates-viewer-${handle}` },
  });
  const writer = await db.user.create({
    data: { displayName: `Updates Writer ${handle}`, username: `updates-writer-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `updates-read-${handle}`,
      name: "Updates read",
      members: { create: [{ userId: viewer.id, role: "owner" }, { userId: writer.id }] },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `updates-read-${handle}`,
      members: { create: [{ userId: viewer.id }, { userId: writer.id }] },
    },
    include: { members: true },
  });
  const writerMember = channel.members.find((member) => member.userId === writer.id)!;
  return { handle, viewer, writer, workspace, channel, writerMember };
}

async function cleanup(
  db: QueryLogDb,
  seeded: { viewer: { id: string }; writer: { id: string }; workspace: { id: string } },
) {
  await db.workspace.delete({ where: { id: seeded.workspace.id } });
  await db.user.deleteMany({ where: { id: { in: [seeded.viewer.id, seeded.writer.id] } } });
  await db.$disconnect();
}

test.skipIf(!connectionString)(
  "browserMessageUpdates costs one id statement when nothing arrived",
  async () => {
    const db = createDb();
    const seeded = await seed(db);
    try {
      const message = await db.message.create({
        data: {
          conversationId: seeded.channel.id,
          workspaceId: seeded.workspace.id,
          senderMemberId: seeded.writerMember.id,
          body: "only message",
          sequence: 1,
        },
      });
      await db.attachment.create({
        data: {
          workspaceId: seeded.workspace.id,
          conversationId: seeded.channel.id,
          uploaderId: seeded.writer.id,
          messageId: message.id,
          position: 0,
          objectKey: `bench/${seeded.handle}/one.txt`,
          fileName: "one.txt",
          contentType: "text/plain",
          sizeBytes: 4,
        },
      });
      const record = recorder(db);

      const nothing = await record.record(() =>
        browserMessageUpdates(db, seeded.channel.id, message.sequence),
      );
      expect(nothing.result).toEqual([]);
      expect(nothing.queries).toHaveLength(1);
      expect(nothing.queries[0]).toContain('"messages"."id"');
      expect(nothing.queries[0]).not.toMatch(MESSAGE_RELATION_TABLES);
      expect(nothing.queries[0]).not.toMatch(SENDER_RELATION_TABLES);

      const arrived = await record.record(() =>
        browserMessageUpdates(db, seeded.channel.id, message.sequence - 1),
      );
      expect(arrived.result).toHaveLength(1);
      const [row] = arrived.result;
      expect(row).toMatchObject({
        id: message.id,
        sequence: message.sequence,
        body: "only message",
        senderMemberId: seeded.writerMember.id,
        sender: { userId: seeded.writer.id, user: { username: seeded.writer.username } },
      });
      expect(row!.attachments.map((attachment) => attachment.fileName)).toEqual(["one.txt"]);
      const view = mapBrowserMessage(row!, seeded.workspace.id);
      expect(view).toMatchObject({
        body: "only message",
        senderName: seeded.writer.displayName!,
        senderHandle: seeded.writer.username,
        senderMemberId: seeded.writerMember.id,
        senderKind: "user",
      });
      expect(view.attachments.map((attachment) => attachment.fileName)).toEqual(["one.txt"]);
    } finally {
      await cleanup(db, seeded);
    }
  },
  60_000,
);

test.skipIf(!connectionString)(
  "browserMessageUpdates keeps the afterReplySequence rule and the conversation scope",
  async () => {
    const db = createDb();
    const seeded = await seed(db);
    try {
      const root = await db.message.create({
        data: {
          conversationId: seeded.channel.id,
          workspaceId: seeded.workspace.id,
          senderMemberId: seeded.writerMember.id,
          body: "root",
          sequence: 1,
        },
      });
      const reply = await db.message.create({
        data: {
          conversationId: seeded.channel.id,
          workspaceId: seeded.workspace.id,
          senderMemberId: seeded.writerMember.id,
          body: "reply",
          sequence: 2,
          threadRootId: root.id,
        },
      });
      const latestRoot = await db.message.create({
        data: {
          conversationId: seeded.channel.id,
          workspaceId: seeded.workspace.id,
          senderMemberId: seeded.writerMember.id,
          body: "later root",
          sequence: 3,
        },
      });
      const elsewhere = await db.conversation.create({
        data: {
          workspaceId: seeded.workspace.id,
          channelName: `${seeded.channel.channelName}-other`,
          members: { create: [{ userId: seeded.viewer.id }, { userId: seeded.writer.id }] },
        },
        include: { members: true },
      });
      const elsewhereWriterMember = elsewhere.members.find(
        (member) => member.userId === seeded.writer.id,
      )!;
      await db.message.create({
        data: {
          conversationId: elsewhere.id,
          workspaceId: seeded.workspace.id,
          senderMemberId: elsewhereWriterMember.id,
          body: "another conversation's message",
          sequence: 2,
        },
      });

      // Top-level after 0 and replies after 1: the reply counts, the other conversation does not.
      const all = await browserMessageUpdates(db, seeded.channel.id, 0, 1);
      expect(all.map((row) => row.id)).toEqual([root.id, reply.id, latestRoot.id]);

      // Top-level after 0 and replies after 3: only the top-level messages.
      const rootsOnly = await browserMessageUpdates(db, seeded.channel.id, 0, 3);
      expect(rootsOnly.map((row) => row.id)).toEqual([root.id, latestRoot.id]);
    } finally {
      await cleanup(db, seeded);
    }
  },
  60_000,
);

test.skipIf(!connectionString)(
  "an updates read that brings nothing new loads no message relation",
  async () => {
    const db = createDb();
    const seeded = await seed(db);
    try {
      const message = await db.message.create({
        data: {
          conversationId: seeded.channel.id,
          workspaceId: seeded.workspace.id,
          senderMemberId: seeded.writerMember.id,
          body: "one message",
          sequence: 1,
        },
      });
      await db.attachment.create({
        data: {
          workspaceId: seeded.workspace.id,
          conversationId: seeded.channel.id,
          uploaderId: seeded.writer.id,
          messageId: message.id,
          position: 0,
          objectKey: `bench/${seeded.handle}/channel.txt`,
          fileName: "channel.txt",
          contentType: "text/plain",
          sizeBytes: 4,
        },
      });
      const record = recorder(db);
      const channels = new PublicChannels(db);

      const arrived = await record.record(() =>
        channels.updates(seeded.workspace.id, seeded.viewer.id, seeded.channel.id, 0),
      );
      expect(arrived.result).toHaveLength(1);
      expect(arrived.result[0]).toMatchObject({
        body: "one message",
        senderName: seeded.writer.displayName!,
        senderHandle: seeded.writer.username,
        senderMemberId: seeded.writerMember.id,
      });
      expect(arrived.result[0]!.attachments.map((attachment) => attachment.fileName)).toEqual([
        "channel.txt",
      ]);

      const nothing = await record.record(() =>
        channels.updates(
          seeded.workspace.id,
          seeded.viewer.id,
          seeded.channel.id,
          message.sequence,
        ),
      );
      expect(nothing.result).toEqual([]);
      expect(nothing.queries.filter((sql) => MESSAGE_RELATION_TABLES.test(sql))).toEqual([]);
      expect(nothing.queries.filter((sql) => SENDER_RELATION_TABLES.test(sql))).toEqual([]);

      const { conversationId: direct } = await new DirectConversations(db).open(
        seeded.workspace.id,
        seeded.viewer.id,
        { userId: seeded.writer.id },
      );
      const directWriterMember = await db.conversationMember.findFirstOrThrow({
        where: { conversationId: direct, userId: seeded.writer.id },
      });
      const directMessage = await db.message.create({
        data: {
          conversationId: direct,
          workspaceId: seeded.workspace.id,
          senderMemberId: directWriterMember.id,
          body: "one direct message",
          sequence: 1,
        },
      });
      const directArrived = await record.record(() =>
        new DirectConversations(db).updates(seeded.workspace.id, seeded.viewer.id, direct, 0),
      );
      expect(directArrived.result).toHaveLength(1);
      expect(directArrived.result[0]).toMatchObject({
        body: "one direct message",
        senderName: seeded.writer.displayName!,
        senderHandle: seeded.writer.username,
      });

      const directNothing = await record.record(() =>
        new DirectConversations(db).updates(
          seeded.workspace.id,
          seeded.viewer.id,
          direct,
          directMessage.sequence,
        ),
      );
      expect(directNothing.result).toEqual([]);
      expect(directNothing.queries.filter((sql) => MESSAGE_RELATION_TABLES.test(sql))).toEqual([]);
    } finally {
      await cleanup(db, seeded);
    }
  },
  60_000,
);
