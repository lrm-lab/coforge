import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { postTaskNotice } from "#src/server/tasks/task-conversations.server";
import { postTaskMessage } from "#src/server/tasks/task-discussion-send.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const channelName = `tae-${suffix}`;

let workspaceId = "";
let ownerId = "";
let boardId = "";
let taskId = "";
let seat = { id: "", userId: null as string | null, agentId: "" as string | null };

beforeAll(async () => {
  const owner = await db.user.create({ data: { username: `tae-${suffix}`, displayName: "owner" } });
  ownerId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-attach-elsewhere-${suffix}`,
      name: "Task attachment elsewhere",
      members: { create: [{ userId: owner.id, role: "member" }] },
    },
  });
  workspaceId = workspace.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId,
      name: `tae-agent-${suffix}`,
      displayName: "Agent",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const board = await db.conversation.create({
    data: {
      workspaceId,
      channelName,
      visibility: "public",
      members: { create: [{ userId: owner.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  boardId = board.id;
  const task = await db.task.create({
    data: {
      conversationId: board.id,
      workspaceId,
      number: 7,
      title: "a task",
      creatorMemberId: board.members[0]!.id,
    },
  });
  taskId = task.id;
  await db.$transaction((tx) =>
    postTaskNotice(tx, { conversationId: board.id, workspaceId }, task.id, { body: "hello" }),
  );
  const agentSeat = board.members.find((member) => member.agentId === agent.id)!;
  seat = { id: agentSeat.id, userId: null, agentId: agent.id };
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: ownerId } });
  await db.$disconnect();
});

const upload = (conversationId: string, name: string) =>
  db.attachment.create({
    data: {
      workspaceId,
      conversationId,
      uploaderAgentId: seat.agentId,
      objectKey: `tae/${suffix}/${name}`,
      fileName: name,
      contentType: "image/png",
      sizeBytes: 10,
    },
  });

const reply = (attachmentIds: string[]) =>
  db
    .$transaction((tx) =>
      postTaskMessage(tx, {
        taskId,
        scope: { conversationId: boardId, workspaceId },
        member: seat,
        body: "see attached",
        attachmentIds,
      }),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );

test("an attachment uploaded to the channel names where it went and the task to upload it to", async () => {
  const inChannel = await upload(boardId, "a.png");
  const refused = await reply([inChannel.id]);
  expect(refused).toBeInstanceOf(AppError);
  expect((refused as AppError).code).toBe("ATTACHMENT_IN_OTHER_CONVERSATION");
  expect((refused as AppError).details).toEqual({
    attachmentId: inChannel.id,
    uploadedTo: `#${channelName}`,
    uploadTo: `#${channelName}:#7`,
  });
  expect((refused as AppError).hint).toContain(`--target '#${channelName}:#7'`);
});

test("only the attachment from elsewhere is named when the others belong to the task", async () => {
  const discussion = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { discussionConversationId: true },
  });
  const inTask = await upload(discussion.discussionConversationId!, "b.png");
  const inChannel = await upload(boardId, "c.png");
  const refused = (await reply([inTask.id, inChannel.id])) as AppError;
  expect(refused.code).toBe("ATTACHMENT_IN_OTHER_CONVERSATION");
  expect(refused.details?.attachmentId).toBe(inChannel.id);
});

test("an id that is not the sender's own upload stays a plain refusal", async () => {
  const refused = (await reply([crypto.randomUUID()])) as AppError;
  expect(refused.code).toBe("ACCESS_DENIED");
});

const discussionId = async () =>
  (
    await db.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { discussionConversationId: true },
    })
  ).discussionConversationId!;

const send = (attachmentIds: string[]) =>
  new PrismaDirectConversationRepository(db)
    .sendAgentMessage(boardId, seat.agentId!, "see attached", attachmentIds)
    .then(
      () => null,
      (error: unknown) => error,
    );

test("a channel message with an attachment uploaded to the task names the task and the channel", async () => {
  const inTask = await upload(await discussionId(), "d.png");
  const refused = (await send([inTask.id])) as AppError;
  expect(refused).toBeInstanceOf(AppError);
  expect(refused.code).toBe("ATTACHMENT_IN_OTHER_CONVERSATION");
  expect(refused.details).toEqual({
    attachmentId: inTask.id,
    uploadedTo: `#${channelName}:#7`,
    uploadTo: `#${channelName}`,
  });
});

test("a channel message names only the attachment from elsewhere", async () => {
  const inChannel = await upload(boardId, "e.png");
  const inTask = await upload(await discussionId(), "f.png");
  const refused = (await send([inChannel.id, inTask.id])) as AppError;
  expect(refused.code).toBe("ATTACHMENT_IN_OTHER_CONVERSATION");
  expect(refused.details?.attachmentId).toBe(inTask.id);
});

test("a channel message with an id that is not the sender's own upload is refused as before", async () => {
  const refused = (await send([crypto.randomUUID()])) as Error;
  expect(refused).not.toBeInstanceOf(AppError);
  expect(refused.message).toBe("attachment is not available for this message");
});
