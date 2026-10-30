import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { RedisClient } from "bun";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { recordingDeliveries } from "./helpers/fake-centrifugo";

function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}

test("a #channel reference is stored as a channel token on every send path, and every Agent-facing body reads it as #name", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Channel references",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    // Every body published to a daemon, decoded as the daemon reads it.
    const { publisher: centrifugo, delivered: published } = recordingDeliveries();
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), centrifugo);
    const general = (await channels.list(workspace.id, user.id))[0]!;
    // Every #general message below must reach the Agent, which joined #general muted.
    await channels.setAgentMuted(workspace.id, helper.id, "#general", false);
    const product = await channels.create(workspace.id, user.id, "product");
    const productToken = `<@channel:${product.id}:product>`;
    const repo = new PrismaDirectConversationRepository(db);
    const sender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      centrifugo,
    );
    const publishedBody = (messageId: string) =>
      published.find((delivery) => delivery.messageId === messageId)?.body;

    // A human channel message: the channel reference is stored as a token next to the mention
    // token; an unknown name, a code span and a thread reference stay as written.
    const typed = "@helper see #Product and #nope, `#product`, #product:deadbeef";
    const readable = "@helper see #product and #nope, `#product`, #product:deadbeef";
    const human = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: typed,
    });
    expect(human.body).toBe(
      `<@agent:${helper.id}> see ${productToken} and #nope, \`#product\`, #product:deadbeef`,
    );
    // Every body that reaches the daemon or the Agent's CLI reads `#product`, never the token.
    expect(publishedBody(human.id)).toBe(readable);
    const bodyOf = (messages: readonly { id?: string; messageId?: string; body: string }[]) =>
      messages.find((message) => (message.id ?? message.messageId) === human.id)?.body;
    // The unread readers first: draining the events advances the Agent's read boundary.
    expect(bodyOf(await repo.readPendingAgentDeliveries(workspace.id, helper.id))).toBe(readable);
    expect(
      bodyOf((await repo.readAgentRecoveryContext(workspace.id, helper.id)).resumeMessages),
    ).toBe(readable);
    expect(
      bodyOf(
        await (await repo.agentTargetFreshness(workspace.id, helper.id, "#general")).readPending(0),
      ),
    ).toBe(readable);
    expect(bodyOf((await repo.drainAgentEvents(workspace.id, helper.id)).messages)).toBe(readable);
    expect(
      bodyOf(await repo.readMessages(workspace.id, helper.id, "#general", { around: human.id })),
    ).toBe(readable);
    // The token keeps the channel's name, so a body search for the name still finds the message.
    expect(
      bodyOf((await repo.searchMessages(workspace.id, helper.id, { query: "product" })).messages),
    ).toBe(readable);
    expect<string>((await repo.resolveAgentMessage(workspace.id, helper.id, human.id)).body).toBe(
      readable,
    );

    // A quote that spans lines keeps its references, and its mention wakes the Agent as before.
    const quote = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "> **Ada** 10:00:\n> @helper see #product\n\nagreed",
    });
    expect(quote.body).toBe(
      `> **Ada** 10:00:\n> <@agent:${helper.id}> see ${productToken}\n\nagreed`,
    );
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: quote.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([helper.id]);
    expect(publishedBody(quote.id)).toBe("> **Ada** 10:00:\n> @helper see #product\n\nagreed");

    // A token the sender typed is stored as typed: it is a claim every consumer checks (the web
    // links a channel only when the Workspace has its id), and an Agent reads it as plain text.
    const forgedChannel = crypto.randomUUID();
    const forged = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: `see <@channel:${forgedChannel}:evil> and <@task:9>`,
    });
    expect(forged.body).toBe(`see <@channel:${forgedChannel}:evil> and <@task:9>`);
    expect(publishedBody(forged.id)).toBe("see #evil and task #9");

    // An Agent channel message.
    const fromAgent = await sender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: "moving this to #product",
    });
    expect(fromAgent.body).toBe(`moving this to ${productToken}`);
    // Push bodies read the same way.
    expect(
      (await new PrismaWebPushSubscriptionStore(db).notificationForMessage(fromAgent.id))?.body,
    ).toBe("@helper: moving this to #product");
    // A Task converted from that message shows its title as text in the view Agents read.
    const converted = await new TaskBoard(db).execute(
      { workspaceId: workspace.id, agentId: helper.id },
      {
        operation: "convert",
        idempotencyKey: crypto.randomUUID(),
        target: "#general",
        messageId: fromAgent.id,
      },
    );
    expect(converted.tasks[0]?.title).toBe("moving this to #product");
    // A converted title carrying a mention token reads it back through the message's mention row.
    const convertedHuman = await new TaskBoard(db).execute(
      { workspaceId: workspace.id, agentId: helper.id },
      {
        operation: "convert",
        idempotencyKey: crypto.randomUUID(),
        target: "#general",
        messageId: human.id,
      },
    );
    expect(convertedHuman.tasks[0]?.title).toBe(readable);

    // A bare `#N` naming a task of this channel is stored as the task token and reads back as
    // `task #N`; a number naming no task here, one beyond any task number, and a `#N` inside code
    // stay as written.
    const taskNumber = converted.tasks[0]!.number;
    const bareTyped = `see #${taskNumber}, not #${taskNumber + 100} or #99999999999 or \`#${taskNumber}\``;
    const bare = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: bareTyped,
    });
    expect(bare.body).toBe(
      `see <@task:${taskNumber}>, not #${taskNumber + 100} or #99999999999 or \`#${taskNumber}\``,
    );
    expect(publishedBody(bare.id)).toBe(
      `see task #${taskNumber}, not #${taskNumber + 100} or #99999999999 or \`#${taskNumber}\``,
    );
    // The same from an Agent, and in a task's own channel only: the DM below has no such task.
    const bareFromAgent = await sender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: `picking up #${taskNumber}`,
    });
    expect(bareFromAgent.body).toBe(`picking up <@task:${taskNumber}>`);

    // A human DM to the Agent: stored as a token, published to the daemon as text.
    const opened = await repo.openForUser(workspace.id, user.id, helper.id);
    const dm = await sender.execute({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: user.id,
      body: `check #product and #${taskNumber}`,
    });
    expect(dm.body).toBe(`check ${productToken} and #${taskNumber}`);
    expect(publishedBody(dm.id)).toBe(`check #product and #${taskNumber}`);

    // An Agent DM reply.
    const reply = await sender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: `@${user.username}`,
      body: "done in #product",
    });
    expect(reply.body).toBe(`done in ${productToken}`);
    expect<string | undefined>(
      (await repo.readMessages(workspace.id, helper.id, `@${user.username}`)).find(
        (message) => message.id === reply.id,
      )?.body,
    ).toBe("done in #product");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("a #name:shortid naming a channel thread is stored as a thread token, and every Agent-facing body reads it as a thread target", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Thread references",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const { publisher: centrifugo, delivered: published } = recordingDeliveries();
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), centrifugo);
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const product = await channels.create(workspace.id, user.id, "product");
    const repo = new PrismaDirectConversationRepository(db);
    const sender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      centrifugo,
    );
    const send = (channelId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId: user.id,
        channelId,
        idempotencyKey: crypto.randomUUID(),
        body,
        threadRootId,
      });
    const publishedBody = (messageId: string) =>
      published.find((delivery) => delivery.messageId === messageId)?.body;

    // A thread root in #product, a reply in it, and two top-level messages whose ids share their
    // first six hex characters.
    const root = await send(product.id, "launch plan");
    const reply = await send(product.id, "first reply", root.id);
    const prefix = crypto.randomUUID().slice(0, 6);
    for (const [index, tail] of ["00", "ff"].entries())
      await db.message.create({
        data: {
          id: `${prefix}${tail}-0000-4000-8000-00000000000${index}`,
          conversationId: product.id,
          workspaceId: workspace.id,
          body: `twin ${index}`,
          sequence: 1_000_000 + index,
        },
      });
    const short = root.id.slice(0, 8);
    const token = `<@thread:${product.id}:${root.id}:product>`;
    const target = `#product:${root.id.slice(0, 13)}`;

    // Every spelling of the root resolves: eight, seven or six hex characters, the whole id, any
    // case. A reply's id, a prefix two messages share, an unknown channel and code stay as written,
    // and none of them is read as a `#product` channel reference.
    const typed = [
      `@helper see #product:${short},`,
      `#PRODUCT:${root.id.slice(0, 7).toUpperCase()},`,
      `#product:${root.id.slice(0, 6)} and 看#product:${root.id}的讨论;`,
      `not #product:${reply.id}, #product:${prefix}, #nope:${short} or \`#product:${short}\``,
    ].join(" ");
    const human = await send(general.id, typed);
    expect(human.body).toBe(
      [
        `<@agent:${helper.id}> see ${token},`,
        `${token},`,
        `${token} and 看${token}的讨论;`,
        `not #product:${reply.id}, #product:${prefix}, #nope:${short} or \`#product:${short}\``,
      ].join(" "),
    );
    const readable = [
      `@helper see ${target},`,
      `${target},`,
      `${target} and 看${target}的讨论;`,
      `not #product:${reply.id}, #product:${prefix}, #nope:${short} or \`#product:${short}\``,
    ].join(" ");

    // Every body that reaches the daemon or the Agent's CLI reads `#product:xxxxxxxx-xxxx`.
    expect(publishedBody(human.id)).toBe(readable);
    const bodyOf = (messages: readonly { id?: string; messageId?: string; body: string }[]) =>
      messages.find((message) => (message.id ?? message.messageId) === human.id)?.body;
    expect(bodyOf(await repo.readPendingAgentDeliveries(workspace.id, helper.id))).toBe(readable);
    expect(
      bodyOf((await repo.readAgentRecoveryContext(workspace.id, helper.id)).resumeMessages),
    ).toBe(readable);
    expect(
      bodyOf(
        await (await repo.agentTargetFreshness(workspace.id, helper.id, "#general")).readPending(0),
      ),
    ).toBe(readable);
    expect(bodyOf((await repo.drainAgentEvents(workspace.id, helper.id)).messages)).toBe(readable);
    expect(
      bodyOf(await repo.readMessages(workspace.id, helper.id, "#general", { around: human.id })),
    ).toBe(readable);
    expect(
      bodyOf((await repo.searchMessages(workspace.id, helper.id, { query: "product" })).messages),
    ).toBe(readable);
    expect<string>((await repo.resolveAgentMessage(workspace.id, helper.id, human.id)).body).toBe(
      readable,
    );

    // An Agent writes one the same way, and can reply to the thread by the target it read.
    const fromAgent = await sender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: `details in ${target}`,
    });
    expect(fromAgent.body).toBe(`details in ${token}`);
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: product.id, agentId: helper.id },
    });
    const threadReply = await sender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target,
      body: "on it",
    });
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: threadReply.id } })).threadRootId,
    ).toBe(root.id);

    // A DM resolves a channel thread too.
    const opened = await repo.openForUser(workspace.id, user.id, helper.id);
    const dm = await sender.execute({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: user.id,
      body: `look at ${target}`,
    });
    expect(dm.body).toBe(`look at ${token}`);
    expect(publishedBody(dm.id)).toBe(`look at ${target}`);

    // After a rename, an Agent still reads the name the message was sent with.
    await db.conversation.update({ where: { id: product.id }, data: { channelName: "launch" } });
    expect<string>(
      (await repo.resolveAgentMessage(workspace.id, helper.id, fromAgent.id)).body,
    ).toBe(`details in ${target}`);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});
