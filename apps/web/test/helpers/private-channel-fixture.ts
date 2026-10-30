import { expect } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { isAppError } from "#src/lib/app-error";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { teardown } from "./workspace-teardown";

/**
 * A Workspace for the private-channel read tests (task #302): an owner who is in the public
 * channel only, an insider who is in every channel and administers them, and an outsider who is in
 * none. `closed` is private, `vault` private and archived, `open` public; each holds a message with
 * a reply, a Task in flight, a finished Task and a file. `direct` is a DM of the insider and the
 * owner. Skipped by the callers unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
export const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

/** The `AppError` code a promise rejects with, else the error's name; undefined when it resolves. */
export async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    if (error instanceof Error) return error.name;
    throw error;
  }
  return undefined;
}

export type PrivateChannelFixture = Awaited<ReturnType<typeof privateChannelFixture>>;
export type PersonRead = [name: string, read: (userId: string) => Promise<unknown>];

export async function privateChannelFixture(url: string) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const names = ["owner", "insider", "outsider"] as const;
  const workspace = await db.workspace.create({
    data: {
      slug: `priv-${suffix}`,
      name: "Private channel reads",
      members: {
        create: names.map((name) => ({
          role: name === "owner" ? "owner" : "member",
          user: { create: { displayName: name, username: `priv-${name}-${suffix}` } },
        })),
      },
    },
    include: { members: { include: { user: true } } },
  });
  const people = Object.fromEntries(
    workspace.members.map(({ user }) => [user.displayName, user.id]),
  ) as Record<(typeof names)[number], string>;
  const ws = workspace.id;
  const token = `secret-${suffix}`;

  const channel = async (name: string, visibility: "public" | "private", archived = false) => {
    const created = await db.conversation.create({
      data: {
        workspaceId: ws,
        channelName: `${name}-${suffix}`,
        visibility,
        archivedAt: archived ? new Date() : null,
        // The owner is in the public channel only; the insider administers both.
        members: {
          create: [
            { userId: people.insider, channelRole: "admin" },
            ...(visibility === "public" ? [{ userId: people.owner }] : []),
          ],
        },
      },
      include: { members: true },
    });
    const insiderRow = created.members.find((member) => member.userId === people.insider)!;
    const message = await db.message.create({
      data: {
        workspaceId: ws,
        conversationId: created.id,
        senderMemberId: insiderRow.id,
        sequence: 1,
        body: `${token} ${visibility} ${name}`,
      },
    });
    const reply = await db.message.create({
      data: {
        workspaceId: ws,
        conversationId: created.id,
        senderMemberId: insiderRow.id,
        sequence: 2,
        threadRootId: message.id,
        body: `${token} reply`,
      },
    });
    await db.task.create({
      data: {
        id: message.id,
        messageId: message.id,
        conversationId: created.id,
        workspaceId: ws,
        number: 1,
        title: `${token} task ${visibility}`,
        creatorMemberId: insiderRow.id,
      },
    });
    // A finished Task, which the board pages apart from the work in flight.
    const finished = await db.message.create({
      data: {
        workspaceId: ws,
        conversationId: created.id,
        senderMemberId: insiderRow.id,
        sequence: 3,
        body: "finished work",
      },
    });
    await db.task.create({
      data: {
        id: finished.id,
        messageId: finished.id,
        conversationId: created.id,
        workspaceId: ws,
        number: 2,
        title: `${token} finished ${visibility}`,
        status: "done",
        creatorMemberId: insiderRow.id,
      },
    });
    const attachment = await db.attachment.create({
      data: {
        workspaceId: ws,
        conversationId: created.id,
        uploaderId: people.insider,
        messageId: message.id,
        objectKey: `workspaces/${ws}/attachments/${crypto.randomUUID()}/original`,
        fileName: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      },
    });
    return { id: created.id, message, reply, attachment, name: `${name}-${suffix}` };
  };
  const open = await channel("open", "public");
  const closed = await channel("closed", "private");
  const vault = await channel("vault", "private", true);

  const directConversation = await db.conversation.create({
    data: {
      workspaceId: ws,
      directKey: peopleDirectKey(people.insider, people.owner),
      members: { create: [{ userId: people.insider }, { userId: people.owner }] },
    },
    include: { members: true },
  });
  const directMessage = await db.message.create({
    data: {
      workspaceId: ws,
      conversationId: directConversation.id,
      senderMemberId: directConversation.members[0]!.id,
      sequence: 1,
      body: "just us",
    },
  });

  return {
    db,
    ws,
    suffix,
    token,
    people,
    /** Those who meet a missing channel where `closed` is. */
    outsiders: [people.outsider, people.owner],
    channels: new PublicChannels(db),
    board: new TaskBoard(db),
    history: new ConversationHistory(db),
    open,
    closed,
    vault,
    direct: { id: directConversation.id, message: directMessage },
    dispose: () => teardown(db, ws, Object.values(people)),
  };
}

/** The insider reads the private channel; the outsider and the owner meet a missing one. */
export async function expectMissingForOutsiders(
  fixture: PrivateChannelFixture,
  reads: PersonRead[],
) {
  for (const [name, read] of reads) {
    for (const userId of fixture.outsiders) {
      expect({ name, error: await errorOf(read(userId)) }).toEqual({ name, error: "NOT_FOUND" });
    }
    // The same read by the insider is not refused as missing.
    expect({ name, error: await errorOf(read(fixture.people.insider)) }).not.toEqual({
      name,
      error: "NOT_FOUND",
    });
  }
}

/** A pin arrangement naming one channel. */
export function pinRef(channelId: string) {
  return { pins: [{ kind: "channel" as const, channelId }], unpinned: [] };
}
