import { expect, test } from "bun:test";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { AppError } from "#src/lib/app-error";

function fakeStorage() {
  return async () => ({
    put: async () => {},
    remove: async () => {},
    head: async () => null,
    open: async () => {
      throw new Error("must not open bytes in this test");
    },
  });
}

function taskThreadAttachmentDb(options: {
  seat: boolean;
  board?: {
    channelName: string | null;
    directKey: string | null;
    visibility: string;
    hiddenFromWorkspaceAt: Date | null;
    members: { leftAt: Date | null }[];
  } | null;
  conversationKind?: string;
}) {
  const lookups: unknown[] = [];
  const db = {
    attachment: {
      findUnique: async () => ({
        id: "attachment-1",
        workspaceId: "workspace-1",
        conversationId: "task-thread-1",
        messageId: "message-1",
        uploaderId: null,
        uploaderAgentId: "agent-uploader",
        objectKey: "workspaces/w/attachments/attachment-1/original",
        fileName: "note.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      }),
    },
    conversationMember: {
      findFirst: async () => (options.seat ? { id: "seat-1" } : null),
    },
    conversation: {
      findFirst: async (query: { where: { kind?: string } }) => {
        lookups.push(query);
        if (query.where.kind !== (options.conversationKind ?? "task_thread")) return null;
        return options.board === undefined || options.board === null
          ? null
          : { taskDiscussionOf: { conversation: options.board } };
      },
    },
  };
  return { db, lookups };
}

const channelBoard = (
  members: { leftAt: Date | null }[],
  hiddenFromWorkspaceAt: Date | null = null,
) => ({
  channelName: "designers",
  directKey: null,
  visibility: "public",
  hiddenFromWorkspaceAt,
  members,
});

const readAs = (db: unknown) =>
  readAuthorizedAttachment(
    db as never,
    { attachmentId: "attachment-1", workspaceId: "workspace-1", agentId: "agent-reader" },
    fakeStorage(),
  );

test("an Agent that joined the board's channel after the upload reads a task discussion attachment without a seat in the discussion", async () => {
  const { db, lookups } = taskThreadAttachmentDb({
    seat: false,
    board: channelBoard([{ leftAt: null }]),
  });
  const result = await readAs(db);
  expect(result.attachment.id).toBe("attachment-1");
  expect(JSON.stringify(lookups)).toContain("agent-reader");
});

test("an Agent that is not on the task's board channel still cannot read its discussion attachment", async () => {
  const { db } = taskThreadAttachmentDb({ seat: false, board: channelBoard([]) });
  await expect(readAs(db)).rejects.toEqual(new AppError("ACCESS_DENIED"));
});

test("an Agent that left the task's board channel cannot read its discussion attachment", async () => {
  const { db } = taskThreadAttachmentDb({
    seat: false,
    board: channelBoard([{ leftAt: new Date("2026-11-01T00:00:00Z") }]),
  });
  await expect(readAs(db)).rejects.toEqual(new AppError("ACCESS_DENIED"));
});

test("a board hidden from the Workspace gives an Agent no access to its discussion attachment", async () => {
  const { db } = taskThreadAttachmentDb({
    seat: false,
    board: channelBoard([{ leftAt: null }], new Date("2026-11-01T00:00:00Z")),
  });
  await expect(readAs(db)).rejects.toEqual(new AppError("ACCESS_DENIED"));
});

test("an Agent seated in a task discussion on a direct board still reads its attachment", async () => {
  const { db, lookups } = taskThreadAttachmentDb({
    seat: true,
    board: {
      channelName: null,
      directKey: "user:u1|agent:a1",
      visibility: "private",
      hiddenFromWorkspaceAt: null,
      members: [],
    },
  });
  const result = await readAs(db);
  expect(result.attachment.id).toBe("attachment-1");
  expect(lookups).toEqual([]);
});

test("an Agent without a seat on a direct board cannot read its task discussion attachment", async () => {
  const { db } = taskThreadAttachmentDb({
    seat: false,
    board: {
      channelName: null,
      directKey: "user:u1|agent:a1",
      visibility: "private",
      hiddenFromWorkspaceAt: null,
      members: [{ leftAt: null }],
    },
  });
  await expect(readAs(db)).rejects.toEqual(new AppError("ACCESS_DENIED"));
});

test("an unseated Agent gets no board fallback outside a task discussion", async () => {
  const { db } = taskThreadAttachmentDb({
    seat: false,
    conversationKind: "channel",
    board: channelBoard([{ leftAt: null }]),
  });
  await expect(readAs(db)).rejects.toEqual(new AppError("ACCESS_DENIED"));
});
