import { attachmentCommentsFixture } from "./helpers/attachment-comments-fixture";
import { expect, test } from "bun:test";
import {
  legacyDiscussion,
  migrationAssistant as privateAssistant,
} from "./helpers/attachment-comment-migration-fixture";

type Fixture = Awaited<ReturnType<typeof legacyDiscussion>>;

async function oldSeat(f: Fixture, attachmentId: string) {
  const thread = await f.db.attachmentCommentThread.findUniqueOrThrow({ where: { attachmentId } });
  return f.db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId: thread.conversationId, userId: f.owner.id } },
  });
}
async function sourceRead(f: Fixture, read: number, done: number | null) {
  const member = await f.db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId: f.conversation.id, userId: f.owner.id } },
  });
  await f.db.threadRead.create({
    data: {
      memberId: member.id,
      conversationId: f.conversation.id,
      workspaceId: f.workspace.id,
      rootMessageId: f.message.id,
      readThroughSequence: read,
      doneThroughSequence: done,
    },
  });
  return member;
}

test("a merged read/Done prefix stops before an unread file even when a later reply was read", async () => {
  const f = await legacyDiscussion();
  try {
    const target = await sourceRead(f, 2, 2);
    const old = await oldSeat(f, f.attachment.id);
    await f.db.conversationMember.update({
      where: { id: old.id },
      data: {
        readThroughSequence: 1,
        doneThroughSequence: 1,
      },
    });
    await f.db.threadRead.create({
      data: {
        memberId: old.id,
        conversationId: old.conversationId,
        workspaceId: f.workspace.id,
        rootMessageId: f.first.id,
        readThroughSequence: 2,
        doneThroughSequence: 2,
      },
    });
    const before = await f.db.threadRead.findMany({
      where: { workspaceId: f.workspace.id },
      orderBy: { memberId: "asc" },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan).toHaveProperty(
      "threadReadMappings",
      expect.arrayContaining([
        expect.objectContaining({
          memberId: target.id,
          conversationId: f.conversation.id,
          rootMessageId: f.message.id,
          readThroughSequence: 3,
          doneThroughSequence: 3,
          reunreadMessages: 1,
        }),
      ]),
    );
    expect(
      await f.db.threadRead.findMany({
        where: { workspaceId: f.workspace.id },
        orderBy: { memberId: "asc" },
      }),
    ).toEqual(before);
    expect(await f.db.conversationMember.findUnique({ where: { id: target.id } })).toEqual(target);
  } finally {
    await f.close();
  }
});

test("read imported comments never advance past an existing unread ordinary reply", async () => {
  const f = await legacyDiscussion();
  try {
    const target = await sourceRead(f, 0, null);
    for (const attachmentId of [f.attachment.id, f.second.id]) {
      const old = await oldSeat(f, attachmentId);
      await f.db.conversationMember.update({
        where: { id: old.id },
        data: { readThroughSequence: 99 },
      });
      if (attachmentId === f.attachment.id)
        await f.db.threadRead.create({
          data: {
            memberId: old.id,
            conversationId: old.conversationId,
            workspaceId: f.workspace.id,
            rootMessageId: f.first.id,
            readThroughSequence: 99,
          },
        });
    }
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan).toHaveProperty(
      "threadReadMappings",
      expect.arrayContaining([
        expect.objectContaining({
          memberId: target.id,
          rootMessageId: f.message.id,
          readThroughSequence: 0,
          reunreadMessages: 3,
        }),
      ]),
    );
  } finally {
    await f.close();
  }
});

test("the assistant's hidden Agent cursor maps to a private cursor without consuming human reads", async () => {
  const f = await legacyDiscussion();
  try {
    const human = await sourceRead(f, 2, 2);
    const { assistant, session } = await privateAssistant(f);
    const old = await oldSeat(f, f.attachment.id);
    const privateSeat = await f.db.conversationMember.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: old.conversationId,
        agentId: assistant.id,
        agentReadThroughSequence: 1,
      },
    });
    await f.db.threadRead.create({
      data: {
        memberId: privateSeat.id,
        conversationId: old.conversationId,
        workspaceId: f.workspace.id,
        rootMessageId: f.first.id,
        readThroughSequence: 2,
      },
    });
    const other = await oldSeat(f, f.second.id);
    await f.db.conversationMember.create({
      data: {
        workspaceId: f.workspace.id,
        conversationId: other.conversationId,
        agentId: assistant.id,
        agentReadThroughSequence: 0,
      },
    });
    const cursor = await f.db.workspaceAssistantReadCursor.create({
      data: {
        sessionId: session.id,
        conversationId: f.conversation.id,
        scope: f.message.id,
        readThroughSequence: 2,
      },
    });
    const humanReads = await f.db.threadRead.findMany({ where: { memberId: human.id } });
    const sourceSeats = await f.db.conversationMember.findMany({
      where: { conversationId: f.conversation.id },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("ready");
    expect(plan).toHaveProperty(
      "assistantReadMappings",
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.id,
          conversationId: f.conversation.id,
          scope: f.message.id,
          readThroughSequence: 3,
          reunreadMessages: 1,
        }),
      ]),
    );
    expect(plan).toHaveProperty(
      "threadReadMappings",
      expect.arrayContaining([
        expect.objectContaining({
          memberId: human.id,
          readThroughSequence: 2,
        }),
      ]),
    );
    expect(await f.db.threadRead.findMany({ where: { memberId: human.id } })).toEqual(humanReads);
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
    ).toEqual(cursor);
    expect(
      await f.db.conversationMember.findMany({ where: { conversationId: f.conversation.id } }),
    ).toEqual(sourceSeats);
  } finally {
    await f.close();
  }
});

test("an uninterpretable private cursor in an old discussion blocks rather than discards state", async () => {
  const f = await legacyDiscussion();
  try {
    const { session } = await privateAssistant(f);
    const old = await oldSeat(f, f.attachment.id);
    await f.db.workspaceAssistantReadCursor.create({
      data: {
        sessionId: session.id,
        conversationId: old.conversationId,
        scope: "not-a-thread-root",
        readThroughSequence: 99,
      },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "invalid-assistant-cursor",
      conversationId: old.conversationId,
    });
  } finally {
    await f.close();
  }
});

test("a foreign-workspace assistant cursor cannot be remapped into this source", async () => {
  const f = await legacyDiscussion();
  const other = await attachmentCommentsFixture();
  try {
    const { session } = await privateAssistant(other);
    const old = await oldSeat(f, f.attachment.id);
    await f.db.workspaceAssistantReadCursor.create({
      data: {
        sessionId: session.id,
        conversationId: old.conversationId,
        scope: "",
        readThroughSequence: 1,
      },
    });
    const plan = await f.migration.preflight();
    expect(plan.status).toBe("blocked");
    expect(plan.moves).toEqual([]);
    expect(plan.blockers).toContainEqual({
      code: "invalid-assistant-cursor",
      conversationId: old.conversationId,
    });
  } finally {
    try {
      await f.close();
    } finally {
      await other.close();
    }
  }
});
