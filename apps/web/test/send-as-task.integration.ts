import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  enrollGeneralChannel,
  PublicChannels,
} from "#src/server/conversations/public-channels.server";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { openPeopleDirectConversation } from "#src/server/conversations/user-direct-conversations.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { sentMessageBecomesTask } from "#src/server/tasks/sent-as-task.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * "As task" in the composer sends the message, as Raft's composer does (`/v2/messages` with
 * `asTask`): one message, with every upload it carries, that is a Task from the moment it exists.
 */
test("a message sent as a task is one message that is a Task and keeps all its uploads", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
  if (!redisUrl) throw new Error("CHANNEL_TEST_REDIS_URL must point to local Redis");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(redisUrl);
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `as-task-${suffix}`, username: `as-task-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: crypto.randomUUID(), name: "As task", members: { create: { userId: user.id } } },
  });
  try {
    await db.$transaction((tx) => enrollGeneralChannel(tx, workspace.id));
    const idempotency = new RedisMessageRequestIdempotency(redis);
    const publisher = {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    };
    const channels = new PublicChannels(db, idempotency, publisher);
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const upload = (conversationId: string, name: string) =>
      db.attachment.create({
        data: {
          workspaceId: workspace.id,
          conversationId,
          uploaderId: user.id,
          objectKey: `as-task/${suffix}/${name}`,
          fileName: name,
          contentType: "text/plain",
          sizeBytes: 1,
        },
      });
    const first = await upload(general.id, "first.txt");
    const second = await upload(general.id, "second.txt");
    const board = new TaskBoard(db);
    const request = {
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Update the quota page",
      attachmentIds: [first.id, second.id],
      withinSend: sentMessageBecomesTask,
    };
    const sent = await channels.send(request);
    await board.announceSentTask(
      { conversationId: general.id, workspaceId: workspace.id },
      sent.id,
    );
    // A retried send (same key) replays the stored message; its announcement is not repeated.
    const replayed = await channels.send(request);
    await board.announceSentTask(
      { conversationId: general.id, workspaceId: workspace.id },
      sent.id,
    );
    expect(replayed.id).toBe(sent.id);

    const stored = await db.message.findUniqueOrThrow({
      where: { id: sent.id },
      select: {
        task: { select: { number: true, title: true, status: true } },
        attachments: { select: { id: true, position: true }, orderBy: { position: "asc" } },
      },
    });
    expect(stored).toEqual({
      task: { number: 1, title: "Update the quota page", status: "todo" },
      attachments: [
        { id: first.id, position: 0 },
        { id: second.id, position: 1 },
      ],
    });
    expect(await db.task.count({ where: { conversationId: general.id } })).toBe(1);
    const notices = await db.message.findMany({
      where: { conversationId: general.id, senderMemberId: null },
      select: { body: true },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("created");

    // A thread reply is never a Task, as `convert` refuses one.
    await expect(
      channels.send({
        ...request,
        idempotencyKey: crypto.randomUUID(),
        attachmentIds: [],
        threadRootId: sent.id,
      }),
    ).rejects.toThrow();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    redis.close();
    await db.$disconnect();
  }
});

test("a message sent as a task in an Agent's DM is a Task with all its uploads", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
  if (!redisUrl) throw new Error("CHANNEL_TEST_REDIS_URL must point to local Redis");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(redisUrl);
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `dm-task-${suffix}`, username: `dm-task-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: crypto.randomUUID(), name: "DM task", members: { create: { userId: user.id } } },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: `helper-${suffix}`,
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const direct = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: agentDirectKey(user.id, agent.id),
        members: { create: [{ userId: user.id }, { agentId: agent.id }] },
      },
    });
    const uploads = await Promise.all(
      ["a.txt", "b.txt"].map((name) =>
        db.attachment.create({
          data: {
            workspaceId: workspace.id,
            conversationId: direct.id,
            uploaderId: user.id,
            objectKey: `dm-task/${suffix}/${name}`,
            fileName: name,
            contentType: "text/plain",
            sizeBytes: 1,
          },
        }),
      ),
    );
    const sent = await new DirectConversations(db).send(
      workspace.id,
      user.id,
      direct.id,
      {
        idempotencyKey: crypto.randomUUID(),
        body: "Fix the DM quota page",
        attachmentIds: uploads.map((upload) => upload.id),
        withinSend: sentMessageBecomesTask,
      },
      {
        idempotency: new RedisMessageRequestIdempotency(redis),
        centrifugo: { publish: async () => {} },
      },
    );
    expect(
      await db.message.findUniqueOrThrow({
        where: { id: sent.id },
        select: {
          task: { select: { number: true } },
          attachments: { select: { id: true }, orderBy: { position: "asc" } },
        },
      }),
    ).toEqual({
      task: { number: 1 },
      attachments: uploads.map((upload) => ({ id: upload.id })),
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    redis.close();
    await db.$disconnect();
  }
});

test("a message sent as a task in a DM between people is a Task with all its uploads", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
  if (!redisUrl) throw new Error("CHANNEL_TEST_REDIS_URL must point to local Redis");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(redisUrl);
  const suffix = crypto.randomUUID().slice(0, 8);
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({
        data: { displayName: `${name}-${suffix}`, username: `${name}-${suffix}` },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "People DM task",
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }] },
    },
  });
  try {
    const { conversationId } = await openPeopleDirectConversation(
      db,
      workspace.id,
      alice!.id,
      bob!.id,
    );
    const uploads = await Promise.all(
      ["a.txt", "b.txt"].map((name) =>
        db.attachment.create({
          data: {
            workspaceId: workspace.id,
            conversationId,
            uploaderId: alice!.id,
            objectKey: `people-task/${suffix}/${name}`,
            fileName: name,
            contentType: "text/plain",
            sizeBytes: 1,
          },
        }),
      ),
    );
    const sent = await new DirectConversations(db).send(
      workspace.id,
      alice!.id,
      conversationId,
      {
        idempotencyKey: crypto.randomUUID(),
        body: "Review the quota copy",
        attachmentIds: uploads.map((upload) => upload.id),
        withinSend: sentMessageBecomesTask,
      },
      {
        idempotency: new RedisMessageRequestIdempotency(redis),
        centrifugo: { publish: async () => {} },
      },
    );
    expect(
      await db.message.findUniqueOrThrow({
        where: { id: sent.id },
        select: {
          task: { select: { number: true } },
          attachments: { select: { id: true }, orderBy: { position: "asc" } },
        },
      }),
    ).toEqual({
      task: { number: 1 },
      attachments: uploads.map((upload) => ({ id: upload.id })),
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.user
      .deleteMany({ where: { id: { in: [alice!.id, bob!.id] } } })
      .catch(() => undefined);
    redis.close();
    await db.$disconnect();
  }
});
