import { expect, test } from "bun:test";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { finishedWorkFixture } from "./fixtures/finished-work";

test("TaskBoard overview and project rows carry discussion reply and file counts", async () => {
  const f = await finishedWorkFixture();
  try {
    await new PrismaExperimentsRepository(f.db).write(f.workspace.id, "taskConversations", true);
    const creator = await f.db.conversationMember.findFirstOrThrow({
      where: { conversationId: f.channel.id, userId: f.viewer.id },
    });
    // A task's own conversation: one reply carrying two files, plus an unsent upload that is not one.
    const discussion = await f.db.conversation.create({
      data: { workspaceId: f.workspace.id, kind: "task_thread" },
    });
    const seat = await f.db.conversationMember.create({
      data: { workspaceId: f.workspace.id, conversationId: discussion.id, userId: f.viewer.id },
    });
    const reply = await f.db.message.create({
      data: {
        conversationId: discussion.id,
        workspaceId: f.workspace.id,
        senderMemberId: seat.id,
        body: "here are the files",
        sequence: 1,
      },
    });
    const file = (messageId: string | null) =>
      f.db.attachment.create({
        data: {
          workspaceId: f.workspace.id,
          conversationId: discussion.id,
          uploaderId: f.viewer.id,
          messageId,
          objectKey: `counts/${crypto.randomUUID()}`,
          fileName: "f.txt",
          contentType: "text/plain",
          sizeBytes: 1,
        },
      });
    await file(reply.id);
    await file(reply.id);
    await file(null);
    const counted = await f.db.task.create({
      data: {
        conversationId: f.channel.id,
        workspaceId: f.workspace.id,
        projectId: f.project.id,
        number: 901,
        title: "Counted work",
        creatorMemberId: creator.id,
        discussionConversationId: discussion.id,
      },
    });
    await f.db.task.create({
      data: {
        conversationId: f.channel.id,
        workspaceId: f.workspace.id,
        number: 902,
        title: "Quiet work",
        creatorMemberId: creator.id,
      },
    });

    const overview = await f.board.overview(f.workspace.id, f.viewer.id);
    const row = overview.tasks.find(({ id }) => id === counted.id)!;
    expect(row).toMatchObject({ replyCount: 1, fileCount: 2 });
    const quiet = overview.tasks.find(({ title }) => title === "Quiet work")!;
    expect(quiet).not.toHaveProperty("replyCount");
    expect(quiet).not.toHaveProperty("fileCount");

    // A Project board's cards carry the same counts.
    const project = await f.board.projectTasks(
      { workspaceId: f.workspace.id, userId: f.viewer.id },
      f.project.id,
    );
    expect(project.tasks.find(({ id }) => id === counted.id)).toMatchObject({
      replyCount: 1,
      fileCount: 2,
      parentTaskId: null,
    });
  } finally {
    await f.cleanup();
  }
});
