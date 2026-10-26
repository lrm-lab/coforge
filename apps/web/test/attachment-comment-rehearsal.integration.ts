import { expect, test } from "bun:test";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Prisma } from "#src/generated/prisma/client";
import { attachmentCommentRehearsalFixture } from "./helpers/attachment-comment-rehearsal-fixture";
import {
  legacyDiscussion,
  migrationAssistant,
} from "./helpers/attachment-comment-migration-fixture";

const TIMEOUT_MS = 90_000;

test(
  "local-copy apply commits preserved history, then its private journal restores the original database",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "coforge-attachment-journal-"));
      const path = join(directory, "journal.json");
      const old = await f.db.attachmentCommentThread.findUniqueOrThrow({
        where: { attachmentId: f.attachment.id },
      });
      const historical = await f.db.conversationMember.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: old.conversationId,
          userId: f.viewer.id,
        },
      });
      await f.db.message.update({
        where: { id: f.first.id },
        data: { senderMemberId: historical.id },
      });
      await f.db.attachmentComment.update({
        where: { messageId: f.first.id },
        data: {
          anchorType: "lines",
          anchorData: { start: 2, end: 4, quote: "selected text" },
        },
      });
      await f.db.messageReaction.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: old.conversationId,
          messageId: f.first.id,
          memberId: historical.id,
          emoji: "👍",
        },
      });
      await f.db.messageMention.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: old.conversationId,
          messageId: f.reply.id,
          memberId: historical.id,
          kind: "user",
          actorId: f.viewer.id,
          handle: f.viewer.username,
        },
      });
      await f.db.savedMessage.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: old.conversationId,
          messageId: f.reply.id,
          memberId: historical.id,
        },
      });
      const sourceMember = await f.db.conversationMember.update({
        where: {
          conversationId_userId: { conversationId: f.conversation.id, userId: f.member.id },
        },
        data: {
          leftAt: new Date("2026-10-20T00:00:00Z"),
          channelRole: "admin",
          channelMuted: true,
        },
      });
      await f.db.threadFollow.create({
        data: {
          memberId: sourceMember.id,
          workspaceId: f.workspace.id,
          conversationId: f.conversation.id,
          rootMessageId: f.message.id,
        },
      });
      await f.db.threadFollow.create({
        data: {
          memberId: historical.id,
          workspaceId: f.workspace.id,
          conversationId: old.conversationId,
          rootMessageId: f.first.id,
        },
      });
      const before = await f.inventory();
      const originals = await f.db.message.findMany({
        where: { id: { in: [f.first.id, f.other.id, f.reply.id] } },
        orderBy: { id: "asc" },
      });
      const journal = await f.migration.applyToLocalCopy({
        persistJournal: async (value: unknown) => {
          const file = await open(path, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(value));
            await file.sync();
          } finally {
            await file.close();
          }
        },
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(path).json()).toEqual(journal);
      const moved = await f.db.message.findMany({
        where: { id: { in: originals.map((row) => row.id) } },
        orderBy: { sequence: "asc" },
      });
      expect(
        moved.map((row) => [row.id, row.conversationId, row.threadRootId, row.sequence]),
      ).toEqual(
        [f.first.id, f.other.id, f.reply.id].map((id, index) => [
          id,
          f.conversation.id,
          f.message.id,
          index + 3,
        ]),
      );
      for (const row of moved) {
        const original = originals.find((entry) => entry.id === row.id)!;
        expect([row.body, row.createdAt, row.reactionVersion]).toEqual([
          original.body,
          original.createdAt,
          original.reactionVersion,
        ]);
      }
      const seat = await f.db.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_userId: { conversationId: f.conversation.id, userId: f.viewer.id },
        },
      });
      expect(seat.leftAt).not.toBeNull();
      expect(seat.channelRole).toBe("member");
      expect(await f.db.conversationMember.findUnique({ where: { id: sourceMember.id } })).toEqual(
        sourceMember,
      );
      expect(
        await f.db.messageReaction.findMany({
          where: { workspaceId: f.workspace.id },
          select: { emoji: true },
          orderBy: { emoji: "asc" },
        }),
      ).toEqual([{ emoji: "✅" }, { emoji: "👍" }]);
      expect(
        await f.db.messageMention.findUnique({
          where: { messageId_memberId: { messageId: f.reply.id, memberId: seat.id } },
        }),
      ).toMatchObject({ actorId: f.viewer.id, conversationId: f.conversation.id });
      expect(
        await f.db.savedMessage.findUnique({
          where: { messageId_memberId: { messageId: f.reply.id, memberId: seat.id } },
        }),
      ).not.toBeNull();
      expect(
        await f.db.attachmentComment.findUnique({ where: { messageId: f.first.id } }),
      ).toMatchObject({
        conversationId: f.conversation.id,
        anchorType: "lines",
        anchorData: { start: 2, end: 4, quote: "selected text" },
      });
      expect(await f.db.attachmentCommentThread.count()).toBe(0);
      expect(await f.db.conversation.count({ where: { kind: "attachment_comments" } })).toBe(0);
      expect(await f.db.agentMessageDelivery.count()).toBe(0);
      expect(await f.db.threadFollow.count()).toBe(1);
      await f.migration.restoreLocalCopy(journal);
      await f.migration.restoreLocalCopy(journal);
      expect(await f.inventory()).toEqual(before);
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        await f.close();
      }
    }
  },
  TIMEOUT_MS,
);

test(
  "a database failure after earlier moves rolls back all rows and DDL",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    try {
      await f.db
        .$executeRaw(Prisma.sql`ALTER TABLE ${Prisma.raw(`"${f.schema}"`)}.messages ADD CONSTRAINT fixture_stop_after_some_moves
      CHECK (body <> 'An existing nested reply' OR sequence <= 2)`);
      const before = await f.inventory();
      let journals = 0;
      await expect(
        f.migration.applyToLocalCopy({
          persistJournal: async () => {
            journals++;
          },
        }),
      ).rejects.toThrow("fixture_stop_after_some_moves");
      expect(journals).toBe(0);
      expect(await f.inventory()).toEqual(before);
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "a journal write failure prevents the local-copy transaction from committing",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    try {
      const before = await f.inventory();
      await expect(
        f.migration.applyToLocalCopy({
          persistJournal: async () => {
            throw new Error("fixture disk full");
          },
        }),
      ).rejects.toThrow("fixture disk full");
      expect(await f.inventory()).toEqual(before);
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "rollback refuses to overwrite ordinary messages written after the local-copy commit",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    try {
      const journal = await f.migration.applyToLocalCopy({ persistJournal: async () => {} });
      const newer = await f.db.message.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: f.conversation.id,
          senderMemberId: f.conversation.members[0]!.id,
          body: "A later ordinary reply must survive",
          sequence: 6,
          threadRootId: f.message.id,
        },
      });
      await expect(f.migration.restoreLocalCopy(journal)).rejects.toThrow(/changed|new writes/i);
      expect(await f.db.message.findUnique({ where: { id: newer.id } })).toEqual(newer);
      expect(await f.db.message.findUnique({ where: { id: f.first.id } })).toMatchObject({
        conversationId: f.conversation.id,
      });
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "a blocked preflight cannot mutate even an authorized local copy",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    try {
      await f.db.attachment.update({ where: { id: f.attachment.id }, data: { messageId: null } });
      const before = await f.inventory();
      await expect(
        f.migration.applyToLocalCopy({ persistJournal: async () => {} }),
      ).rejects.toThrow(/preflight.*blocked/i);
      expect(await f.inventory()).toEqual(before);
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "the ordinary preflight store has no local-copy write capability",
  async () => {
    const f = await legacyDiscussion();
    try {
      const before = await f.db.message.findMany({
        where: { workspaceId: f.workspace.id },
        orderBy: { id: "asc" },
      });
      await expect(
        f.migration.applyToLocalCopy({ persistJournal: async () => {} }),
      ).rejects.toThrow(/local copy/i);
      expect(
        await f.db.message.findMany({
          where: { workspaceId: f.workspace.id },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "an invalid journal is rejected before any restoration SQL runs",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    try {
      const journal = await f.migration.applyToLocalCopy({ persistJournal: async () => {} });
      const applied = await f.inventory();
      const invalid = structuredClone(journal);
      invalid.scope.messageIds[0] = "not-a-uuid";
      await expect(f.migration.restoreLocalCopy(invalid)).rejects.toThrow(
        "Invalid local copy migration journal",
      );
      expect(await f.inventory()).toEqual(applied);
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "committed copy moves assistant cursors independently and restores all old private state",
  async () => {
    const f = await attachmentCommentRehearsalFixture();
    try {
      const human = await f.db.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_userId: { conversationId: f.conversation.id, userId: f.owner.id },
        },
      });
      const humanRead = await f.db.threadRead.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: f.conversation.id,
          memberId: human.id,
          rootMessageId: f.message.id,
          readThroughSequence: 2,
          doneThroughSequence: 2,
        },
      });
      const { assistant, session } = await migrationAssistant(f);
      for (const attachmentId of [f.attachment.id, f.second.id]) {
        const thread = await f.db.attachmentCommentThread.findUniqueOrThrow({
          where: { attachmentId },
        });
        const seat = await f.db.conversationMember.create({
          data: {
            workspaceId: f.workspace.id,
            conversationId: thread.conversationId,
            agentId: assistant.id,
            agentReadThroughSequence: attachmentId === f.attachment.id ? 1 : 0,
          },
        });
        await f.db.workspaceAssistantReadCursor.create({
          data: {
            sessionId: session.id,
            conversationId: thread.conversationId,
            scope: "",
            readThroughSequence: seat.agentReadThroughSequence,
          },
        });
        if (attachmentId === f.attachment.id) {
          await f.db.threadRead.create({
            data: {
              workspaceId: f.workspace.id,
              conversationId: thread.conversationId,
              memberId: seat.id,
              rootMessageId: f.first.id,
              readThroughSequence: 2,
            },
          });
          await f.db.workspaceAssistantReadCursor.create({
            data: {
              sessionId: session.id,
              conversationId: thread.conversationId,
              scope: f.first.id,
              readThroughSequence: 2,
            },
          });
        }
      }
      await f.db.workspaceAssistantReadCursor.create({
        data: {
          sessionId: session.id,
          conversationId: f.conversation.id,
          scope: f.message.id,
          readThroughSequence: 2,
        },
      });
      const before = await f.inventory();
      const journal = await f.migration.applyToLocalCopy({ persistJournal: async () => {} });
      expect(
        await f.db.threadRead.findUnique({
          where: {
            memberId_rootMessageId: {
              memberId: human.id,
              rootMessageId: f.message.id,
            },
          },
        }),
      ).toEqual(humanRead);
      expect(await f.db.conversationMember.findUnique({ where: { id: human.id } })).toEqual(human);
      expect(
        await f.db.workspaceAssistantReadCursor.findUnique({
          where: {
            sessionId_conversationId_scope: {
              sessionId: session.id,
              conversationId: f.conversation.id,
              scope: f.message.id,
            },
          },
        }),
      ).toMatchObject({ readThroughSequence: 3 });
      expect(
        await f.db.workspaceAssistantReadCursor.count({ where: { sessionId: session.id } }),
      ).toBe(1);
      expect(
        await f.db.conversationMember.findUnique({
          where: {
            conversationId_agentId: {
              conversationId: f.conversation.id,
              agentId: assistant.id,
            },
          },
        }),
      ).toBeNull();
      await f.migration.restoreLocalCopy(journal);
      expect(await f.inventory()).toEqual(before);
    } finally {
      await f.close();
    }
  },
  TIMEOUT_MS,
);
