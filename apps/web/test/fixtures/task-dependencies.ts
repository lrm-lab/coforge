import { expect } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type {
  TaskWriteCommand,
  TaskPrincipal,
  TaskCommandWithout,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import type { TaskBoardDependencies } from "#src/server/tasks/task-board-ports.server";

/**
 * A Workspace with two people (one an owner), two Agents and two channels (and a private third),
 * and a board to drive.
 */
export async function setup({ dependencies }: { dependencies?: TaskBoardDependencies } = {}) {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: {
      displayName: `dep-alice-${handle}`,
      username: `dep-alice-${handle}`,
    },
  });
  const bob = await db.user.create({
    data: { displayName: `dep-bob-${handle}`, username: `dep-bob-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-dep-${handle}`,
      name: "Task dependencies",
      members: {
        create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }],
      },
      agents: {
        create: ["one", "two"].map((name) => ({
          name: `${name}-${handle}`,
          displayName: name,
          ownerId: alice.id,
          runtimeConfig: {},
        })),
      },
    },
    include: { agents: true },
  });
  const [one, two] = workspace.agents.sort((a, b) => a.name.localeCompare(b.name)) as [
    (typeof workspace.agents)[number],
    (typeof workspace.agents)[number],
  ];
  const members = [
    { userId: alice.id },
    { userId: bob.id },
    { agentId: one.id },
    { agentId: two.id },
  ];
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `deps-${handle}`,
      members: { create: members },
    },
  });
  const other = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `deps-other-${handle}`,
      members: { create: members },
    },
  });
  // A private channel only the owner and one Agent belong to.
  const secret = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `deps-secret-${handle}`,
      visibility: "private",
      members: { create: [{ userId: alice.id }, { agentId: one.id }] },
    },
  });
  // A public channel the Workspace owner (alice) is not in: task #512's non-member admin case.
  const admin = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `deps-admin-${handle}`,
      members: { create: [{ userId: bob.id }, { agentId: one.id }] },
    },
  });
  // A private channel the Workspace owner is not in either: the member-less admin path does
  // not reach one, so her write is refused like any other non-member's.
  const secretAdmin = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `deps-secret-admin-${handle}`,
      visibility: "private",
      members: { create: [{ userId: bob.id }, { agentId: one.id }] },
    },
  });
  const sourceMessages = new Map<string, string>();
  const ownerMember = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channel.id, userId: alice.id },
  });
  for (const conv of [channel, other, secret, admin, secretAdmin]) {
    const sender =
      conv.id === channel.id
        ? ownerMember
        : await db.conversationMember.findFirstOrThrow({
            where: { conversationId: conv.id, userId: { not: null } },
          });
    const message = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: conv.id,
        sequence: 1,
        senderMemberId: sender.id,
        body: `Seed request ${handle}`,
      },
    });
    sourceMessages.set(conv.id, message.id);
  }
  const board = new TaskBoard(db, dependencies);
  const principals = {
    alice: { workspaceId: workspace.id, userId: alice.id } as TaskPrincipal,
    bob: { workspaceId: workspace.id, userId: bob.id } as TaskPrincipal,
    one: { workspaceId: workspace.id, agentId: one.id } as TaskPrincipal,
    two: { workspaceId: workspace.id, agentId: two.id } as TaskPrincipal,
  };
  const boards = new Map([
    [channel.id, `#${channel.channelName}`],
    [other.id, `#${other.channelName}`],
    [secret.id, `#${secret.channelName}`],
    [admin.id, `#${admin.channelName}`],
    [secretAdmin.id, `#${secretAdmin.channelName}`],
  ]);
  const run = (
    who: keyof typeof principals,
    command: TaskCommandWithout<"idempotencyKey" | "conversationId" | "target">,
    conversationId = channel.id,
  ) =>
    board.execute(principals[who], {
      idempotencyKey: crypto.randomUUID(),
      ...(who === "one" || who === "two"
        ? { target: boards.get(conversationId)! }
        : { conversationId }),
      ...command,
    });
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  };
  const make = async (
    who: keyof typeof principals,
    count: number,
    extra: Partial<Extract<TaskWriteCommand, { operation: "create" }>> = {},
    conversationId = channel.id,
  ) =>
    (
      await run(
        who,
        {
          operation: "create",
          titles: Array.from({ length: count }, (_, index) => `Task ${index + 1} ${handle}`),
          ...((who === "one" || who === "two") && extra.messageId === undefined
            ? { messageId: sourceMessages.get(conversationId) }
            : {}),
          ...extra,
        },
        conversationId,
      )
    ).tasks.map((task) => task.number);
  const show = async (number: number, conversationId = channel.id) =>
    run("alice", { operation: "show", number }, conversationId);
  const notices = async (number: number) => {
    const task = await db.task.findFirstOrThrow({
      where: { conversationId: channel.id, number },
      select: { messageId: true, discussionConversationId: true },
    });
    if (!task.messageId && !task.discussionConversationId) return [];
    const messages = await db.message.findMany({
      where: task.messageId
        ? { threadRootId: task.messageId, systemMessage: { isNot: null } }
        : {
            conversationId: task.discussionConversationId!,
            systemMessage: { isNot: null },
          },
      orderBy: { sequence: "asc" },
      select: {
        id: true,
        systemMessage: { select: { kind: true } },
        deliveries: true,
      },
    });
    return messages.map((message) => ({
      kind: message.systemMessage!.kind,
      agents: message.deliveries.map((delivery) => delivery.agentId),
    }));
  };
  const finish = async (who: "one" | "two", number: number) => {
    await run(who, { operation: "claim", number });
    await run(who, { operation: "update", number, status: "done" });
  };
  return {
    db,
    board,
    principals,
    run,
    make,
    show,
    notices,
    finish,
    refusal,
    channel,
    secretAdmin,
    other,
    admin,
    secret,
    one,
    two,
  };
}
