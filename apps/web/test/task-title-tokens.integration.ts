import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/** A Task's title keeps its reference tokens, and the mention rows it stores decide which Agent a
 * muted channel wakes; and a message is found by its eight-character id, never ambiguously.
 * Split from `tasks.integration.ts`, which the size ratchet keeps from growing. */

test("a created Task's title stores its references as tokens, and its own mention rows decide who a muted channel wakes", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({
    data: { displayName: `tokens-${suffix}`, username: `tokens-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-tokens-${suffix}`,
      name: "Task tokens",
      members: { create: { userId: human.id, role: "owner" } },
      agents: {
        create: ["helper", "quiet", "open"].map((name) => ({
          name: `${name}-${suffix}`,
          displayName: name,
          ownerId: human.id,
          runtimeConfig: {},
        })),
      },
    },
    include: { agents: true },
  });
  const agentNamed = (name: string) =>
    workspace.agents.find((agent) => agent.name === `${name}-${suffix}`)!;
  const [helper, quiet, open] = [agentNamed("helper"), agentNamed("quiet"), agentNamed("open")];
  const computer = await db.computer.create({
    data: { ownerId: human.id, machineId: crypto.randomUUID() },
  });
  await db.agent.updateMany({
    where: { workspaceId: workspace.id },
    data: { computerId: computer.id },
  });
  try {
    const product = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `product-${suffix}` },
    });
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `work-${suffix}`,
        members: {
          create: [
            { userId: human.id },
            { agentId: helper.id, channelMuted: true },
            { agentId: quiet.id, channelMuted: true },
            { agentId: open.id },
          ],
        },
      },
    });
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const board = new TaskBoard(db, {
      publisher: {
        async publish(_channel, payload) {
          published.push(decodeAgentMessageDelivery(payload));
        },
      },
    });
    const principal = { workspaceId: workspace.id, userId: human.id };
    const existing = (
      await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Existing task",
      })
    ).tasks[0]!;
    published.length = 0;

    const created = await board.execute(principal, {
      operation: "create",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      titles: [
        `@${helper.name} see #product-${suffix} and task #${existing.number}`,
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
      ],
      assignee: `@${helper.name}`,
    });
    const [referencing, codeOnly] = created.tasks;
    const rows = await db.message.findMany({
      where: { id: { in: [referencing!.messageId, codeOnly!.messageId] } },
      orderBy: { sequence: "asc" },
      select: {
        body: true,
        task: { select: { title: true } },
        mentions: { select: { actorId: true } },
        deliveries: { select: { agentId: true } },
      },
    });

    // The Task's message stores its references as tokens, and the Task keeps that same body as its
    // title, as a converted Task keeps its message's.
    const tokenized = `<@agent:${helper.id}> see <@channel:${product.id}:product-${suffix}> and <@task:${existing.number}>`;
    expect(rows.map((row) => [row.body, row.task!.title])).toEqual([
      [tokenized, tokenized],
      [
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
      ],
    ]);
    expect(rows.map((row) => row.mentions.map((mention) => mention.actorId))).toEqual([
      [helper.id],
      [],
    ]);
    // Every reader still sees text.
    const readable = `@${helper.name} see #product-${suffix} and task #${existing.number}`;
    expect(referencing!.title).toBe(readable);
    const notice = await db.message.findFirstOrThrow({
      where: { conversationId: channel.id, senderMemberId: null, body: { contains: "created" } },
      orderBy: { sequence: "desc" },
      select: { body: true },
    });
    expect(notice.body).toContain(`"${readable}"`);
    expect(notice.body).not.toContain("<@");

    // Each Task's message wakes every unmuted Agent, plus a muted Agent its own mention rows name.
    // The quiet Agent, written only in code and a link label, stays muted.
    expect(rows.map((row) => row.deliveries.map((delivery) => delivery.agentId).sort())).toEqual([
      [helper.id, open.id].sort(),
      [open.id],
    ]);
    const taskPayloads = published.filter(
      (payload) => payload.messageId === referencing!.messageId,
    );
    expect(taskPayloads.map((payload) => [payload.agentId, payload.body]).sort()).toEqual(
      [
        [helper.id, readable],
        [open.id, readable],
      ].sort(),
    );

    // The assignment receipt is unchanged: top level in the conversation, delivered only to the
    // assignee, on the conversation's own target.
    const receipt = await db.message.findUniqueOrThrow({
      where: { id: created.assignmentReceipt!.messageId },
      select: { threadRootId: true, deliveries: { select: { agentId: true } } },
    });
    expect(receipt).toEqual({ threadRootId: null, deliveries: [{ agentId: helper.id }] });
    expect(
      published
        .filter((payload) => payload.messageId === created.assignmentReceipt!.messageId)
        .map((payload) => [payload.agentId, payload.target]),
    ).toEqual([[helper.id, `#${channel.channelName}`]]);

    // Amending compares titles as they read: re-sending the same readable title changes nothing
    // (no history, tokens kept), and a real change is recorded in readable form.
    const amend = (title: string) =>
      board.execute(principal, {
        operation: "amend",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: referencing!.number,
        title,
      });
    const unchanged = await amend(readable);
    expect(unchanged.history ?? []).toEqual([]);
    expect(unchanged.tasks[0]!.title).toBe(readable);
    expect(
      (await db.task.findUniqueOrThrow({ where: { messageId: referencing!.messageId } })).title,
    ).toBe(tokenized);
    const renamed = await amend("A new title");
    expect(renamed.history).toEqual([
      expect.objectContaining({
        eventType: "amended",
        payload: expect.objectContaining({
          changes: { title: { from: readable, to: "A new title" } },
        }),
      }),
    ]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});

test("converting by an eight-character message id finds only that channel's top-level message, in any case, and refuses an ambiguous one", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({
    data: { displayName: `short-id-${suffix}`, username: `short-id-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-short-id-${suffix}`,
      name: "Task short ids",
      members: { create: { userId: human.id, role: "owner" } },
    },
  });
  try {
    const [channel, other] = await Promise.all(
      ["work", "other"].map((name) =>
        db.conversation.create({
          data: {
            workspaceId: workspace.id,
            channelName: `${name}-${suffix}`,
            members: { create: { userId: human.id } },
          },
          include: { members: true },
        }),
      ),
    );
    // Ids that share a first eight characters, built so each prefix below names a known set.
    const id = (prefix: string, tail: string) =>
      `${prefix}-0000-4000-8000-${tail.padStart(12, "0")}`;
    const post = (
      conversation: typeof channel,
      messageId: string,
      sequence: number,
      threadRootId?: string,
    ) =>
      db.message.create({
        data: {
          id: messageId,
          workspaceId: workspace.id,
          conversationId: conversation!.id,
          senderMemberId: conversation!.members[0]!.id,
          sequence,
          body: `Message ${sequence}`,
          threadRootId,
        },
      });
    const unique = await post(channel, id("abcdef01", "1"), 1);
    // The same prefix as a reply here and as a top-level message elsewhere names nothing extra.
    await post(channel, id("abcdef01", "2"), 2, unique.id);
    await post(other, id("abcdef01", "3"), 1);
    await post(channel, id("abcdef02", "1"), 3);
    await post(channel, id("abcdef02", "2"), 4);

    const board = new TaskBoard(db);
    const convert = (messageId: string) =>
      board.execute(
        { workspaceId: workspace.id, userId: human.id },
        {
          operation: "convert",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel!.id,
          messageId,
        },
      );
    expect((await convert("ABCDEF01")).tasks[0]).toMatchObject({ messageId: unique.id });
    await expect(convert("abcdef02")).rejects.toThrow("CONFLICT");
    await expect(convert("abcdef03")).rejects.toThrow("NOT_FOUND");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});
