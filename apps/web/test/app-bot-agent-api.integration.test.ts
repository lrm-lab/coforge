import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { handleAgentMessagesGet, handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import {
  authenticateAppBotRequest,
  handleAppBotEventsGet,
} from "#src/server/app-bots/app-bot-agent-api.server";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { MentionDeliveryIssuer } from "#src/server/conversations/mention-deliveries.server";
import type {
  MessageRequestIdempotency,
  MessageRequestRecords,
} from "#src/server/conversations/message-request-idempotency.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { botFixture, type BotFixture } from "./app-bots-fixture";

/**
 * An app's bot on the Agent API against local PostgreSQL: its key alone opens the four
 * capabilities and nothing else, it can start a direct message with any member but post only to a
 * channel it was added to, nothing is pushed to a daemon for it, and its messages keep their
 * sender through a revoke and a new grant.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const runnable = Boolean(connectionString);
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const fixtures: BotFixture[] = [];
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});
afterAll(async () => {
  await db?.$disconnect();
});

const API = "https://coforge.test/api/agent/v1";
const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };

/** A Workspace with a granted bot, its key, and an Agent API request builder for it. */
async function bot() {
  const f = await botFixture(db!);
  fixtures.push(f);
  await f.bots.grant(f.actor("admin"), f.key);
  const { agentId } = (await f.botRow())!;
  const apiKey = (await f.bots.mintKey(f.key, f.installationId, false)) as {
    ok: true;
    key: { apiKey: string };
  };
  const key = apiKey.key.apiKey;
  const request = (path: string, init: RequestInit = {}) =>
    new Request(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...init.headers },
    });
  const principal = { workspaceId: f.workspaceId, agentId };
  return { f, agentId, key, request, principal };
}

/** Every Centrifugo publication of a test, by channel. */
const published: string[] = [];
const publisher = {
  async publish(channel: string) {
    published.push(channel);
  },
  async publishJson() {},
} as unknown as CentrifugoServerApi;
const requestRecords: MessageRequestRecords = { find: async () => undefined };

/** What the send route runs on, with request records that remember nothing and a recording
 * publisher in place of Centrifugo and Redis. */
function sendDependencies() {
  const repository = new PrismaDirectConversationRepository(db!, { oneRequest: true });
  return {
    repository,
    requestRecords,
    sender: new SendDirectMessage(
      repository,
      passThrough,
      publisher,
      undefined,
      undefined,
      new MentionDeliveryIssuer(new PrismaMentionDeliveryRepository(db!)),
    ),
  };
}

async function send(
  b: Awaited<ReturnType<typeof bot>>,
  target: string,
  content: string,
): Promise<Response> {
  return handleAgentMessagesPost(
    new Request(`${API}/messages`, {
      method: "POST",
      body: JSON.stringify({
        target,
        content,
        idempotencyKey: crypto.randomUUID(),
        seenUpToSeq: 0,
      }),
    }),
    b.principal,
    sendDependencies(),
  );
}

describe.skipIf(!runnable)("the Agent API door for a bot key", () => {
  test("the key alone opens the four capabilities and answers the bot's identity", async () => {
    const b = await bot();
    for (const [method, path] of [
      ["POST", "/messages"],
      ["GET", "/messages?target=%40x"],
      ["GET", "/messages/search?query=x"],
      ["GET", "/events"],
      ["GET", "/channels/general"],
      ["GET", "/users/someone"],
    ] as const) {
      const outcome = await authenticateAppBotRequest(b.request(path, { method }), b.f.bots);
      expect(outcome).toMatchObject({
        principal: { agentId: b.agentId, workspaceId: b.f.workspaceId },
      });
    }
  });

  test("everything outside the four capabilities is capability_not_granted (403)", async () => {
    const b = await bot();
    for (const [method, path] of [
      ["POST", "/tasks"],
      ["POST", "/openviking"],
      ["POST", "/attachments"],
      ["POST", "/attachment-upload-sessions"],
      ["POST", "/channels"],
      ["POST", "/channels/general/join"],
      ["POST", "/channels/general/members"],
      ["POST", "/channels/general/archive"],
      ["POST", "/reminders"],
      ["GET", "/workspace"],
      ["GET", "/apps"],
    ] as const) {
      const outcome = await authenticateAppBotRequest(b.request(path, { method }), b.f.bots);
      expect(outcome).toBeInstanceOf(Response);
      const response = outcome as Response;
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("capability_not_granted");
    }
  });

  test("requests that are not a bot's go to the Computer door; a key that does not hold is 401", async () => {
    const b = await bot();
    const door = (headers: Record<string, string>) =>
      authenticateAppBotRequest(new Request(`${API}/events`, { headers }), b.f.bots);
    expect(await door({})).toBeUndefined();
    expect(await door({ authorization: "Bearer not-an-agent-key" })).toBeUndefined();
    // A Computer's Agent sends its own key in the second header; that is never a bot request.
    expect(
      await door({
        authorization: `Bearer ${b.key}`,
        "x-coforge-agent-api-key": `Bearer ${b.key}`,
      }),
    ).toBeUndefined();
    const unknown = (await door({
      authorization: `Bearer sk_agent_${"A".repeat(43)}`,
    })) as Response;
    expect(unknown.status).toBe(401);

    await b.f.bots.revoke(b.f.actor("admin"), b.f.key);
    expect(((await door({ authorization: `Bearer ${b.key}` })) as Response).status).toBe(401);
  });
});

describe.skipIf(!runnable)("a bot's messages", () => {
  test("it starts a direct message with a member itself, and the message is the bot's", async () => {
    const b = await bot();
    const member = b.f.people.member;
    const response = await send(b, `@${member.username}`, "hello from the app");
    expect(await response.json()).toMatchObject({ state: "sent" });
    const message = await db!.message.findFirstOrThrow({
      where: { workspaceId: b.f.workspaceId, body: "hello from the app" },
      include: { sender: true, conversation: { include: { members: true } } },
    });
    expect(message.sender?.agentId).toBe(b.agentId);
    expect(message.conversation.members.map((m) => m.userId).filter(Boolean)).toEqual([member.id]);
  });

  test("it cannot post to a channel it was not added to; once added, it can", async () => {
    const b = await bot();
    const channel = await db!.conversation.create({
      data: {
        workspaceId: b.f.workspaceId,
        channelName: `ops-${b.f.suffix}`,
        members: { create: [{ userId: b.f.people.owner.id }] },
      },
    });
    await expect(send(b, `#ops-${b.f.suffix}`, "let me in")).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(await db!.message.count({ where: { conversationId: channel.id } })).toBe(0);

    await db!.conversationMember.create({
      data: { workspaceId: b.f.workspaceId, conversationId: channel.id, agentId: b.agentId },
    });
    const sent = await send(b, `#ops-${b.f.suffix}`, "hello channel");
    expect(await sent.json()).toMatchObject({ state: "sent" });
  });

  test("a granted bot is in no channel, #general included, however often #general is brought up to date", async () => {
    const b = await bot();
    await db!.$transaction((tx) => enrollGeneralChannel(tx, b.f.workspaceId));
    await db!.$transaction((tx) => enrollGeneralChannel(tx, b.f.workspaceId));
    expect(await db!.conversationMember.count({ where: { agentId: b.agentId } })).toBe(0);
    // An ordinary public Agent is enrolled by the same call, so the bot's absence is the rule.
    const ordinary = await db!.agent.create({
      data: {
        workspaceId: b.f.workspaceId,
        name: `plain-${b.f.suffix}`,
        displayName: "Plain",
        ownerId: b.f.people.owner.id,
        runtimeConfig: {},
      },
    });
    await db!.$transaction((tx) => enrollGeneralChannel(tx, b.f.workspaceId));
    const members = await db!.conversationMember.findMany({
      where: { agentId: { in: [b.agentId, ordinary.id] } },
    });
    expect(members.map((member) => member.agentId)).toEqual([ordinary.id]);
  });

  test("a message to the bot launches nothing and pushes nothing to a daemon; its app reads it from the inbox", async () => {
    const b = await bot();
    const published: string[] = [];
    const publisher = {
      async publish(channel: string) {
        published.push(channel);
      },
      async publishJson() {},
    } as unknown as CentrifugoServerApi;
    const conversations = new PrismaDirectConversationRepository(db!);
    const member = b.f.people.member;
    const conversation = await conversations.getOrCreateUserAgent(
      b.f.workspaceId,
      member.id,
      b.agentId,
    );
    const memberRow = await db!.conversationMember.findFirstOrThrow({
      where: { conversationId: conversation.id, userId: member.id },
    });
    const sender = new SendDirectMessage(conversations, passThrough, publisher);
    await sender.execute({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: b.f.workspaceId,
      conversationId: conversation.id,
      senderMemberId: memberRow.id,
      senderUserId: member.id,
      body: `please review, @${b.f.key}`,
    });

    // Nothing was pushed to any Computer's control channel.
    expect(published.filter((channel) => channel.startsWith("daemon"))).toEqual([]);
    expect(published).toEqual(expect.not.arrayContaining([expect.stringMatching(/computer/i)]));
    // No control path finds the Agent to launch: it has no Computer.
    expect(await new PrismaAgentControlStore(db!).get(b.agentId)).toBeUndefined();
    // The delivery waits, unconsumed, for the app's poll.
    const delivery = await db!.agentMessageDelivery.findFirstOrThrow({
      where: { agentId: b.agentId },
    });
    expect(delivery.receivedAt).toBeNull();

    const events = await handleAppBotEventsGet(b.request("/events"), b.principal, db!);
    const body = await events.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].body).toContain("please review");
  });

  test("a channel @mention of a bot is not a tracked launch: it waits, never lost, for the app's poll", async () => {
    const b = await bot();
    const channel = await db!.conversation.create({
      data: {
        workspaceId: b.f.workspaceId,
        channelName: `ops-${b.f.suffix}`,
        members: {
          create: [{ userId: b.f.people.owner.id }, { agentId: b.agentId, channelMuted: true }],
        },
      },
    });
    published.length = 0;
    const channels = new PublicChannels(db!, passThrough, publisher, undefined, {
      async messageAvailable() {},
      async memberChanged() {},
    });
    const message = await channels.send({
      workspaceId: b.f.workspaceId,
      userId: b.f.people.owner.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@${b.f.key} please review`,
    });
    const delivery = await db!.agentMessageDelivery.findFirstOrThrow({
      where: { messageId: message.id, agentId: b.agentId },
    });
    expect(delivery.mentionOutcome).not.toBe("lost");
    expect(delivery.mentionReasonCategory).toBeNull();
    expect(published).toEqual([]);
    const events = await handleAppBotEventsGet(b.request("/events"), b.principal, db!);
    expect((await events.json()).events.map((e: { body: string }) => e.body)).toEqual([
      expect.stringContaining("please review"),
    ]);
  });

  test("messages keep their sender through a revoke and a new grant, and a new generation needs a new key", async () => {
    const b = await bot();
    await send(b, `@${b.f.people.member.username}`, "before");
    await b.f.bots.revoke(b.f.actor("admin"), b.f.key);
    await b.f.bots.grant(b.f.actor("admin"), b.f.key);
    const row = (await b.f.botRow())!;
    expect(row.generation).toBe(2);
    expect(row.agentId).toBe(b.agentId);
    const old = await authenticateAppBotRequest(b.request("/events"), b.f.bots);
    expect((old as Response).status).toBe(401);

    const minted = (await b.f.bots.mintKey(b.f.key, b.f.installationId, false)) as {
      ok: true;
      key: { apiKey: string };
    };
    const again = { ...b, key: minted.key.apiKey };
    await send(again, `@${b.f.people.member.username}`, "after");
    const messages = await db!.message.findMany({
      where: { workspaceId: b.f.workspaceId, body: { in: ["before", "after"] } },
      include: { sender: true },
    });
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.sender?.agentId))).toEqual(
      new Set([b.agentId]),
    );
    const history = await handleAgentMessagesGet(
      b.request(`/messages?target=%40${b.f.people.member.username}`),
      b.principal,
      new PrismaDirectConversationRepository(db!),
    );
    // The bot reads its own history under its handle, the app's key, before and after the new grant.
    expect((await history.json()).messages).toMatchObject([
      { senderKind: "agent", senderHandle: b.f.key, body: "before" },
      { senderKind: "agent", senderHandle: b.f.key, body: "after" },
    ]);
  });
});

describe.skipIf(!runnable)("AgentControl", () => {
  test("refuses to start, restart or stop a bot Agent and publishes nothing to any daemon", async () => {
    const b = await bot();
    const commands: unknown[] = [];
    const control = new AgentControl(
      new PrismaAgentControlStore(db!),
      { publish: async (...command: unknown[]) => void commands.push(command) },
      { run: (_agentId: string, work: () => Promise<unknown>) => work() } as never,
    );
    for (const action of ["start", "restart", "stop"] as const) {
      await expect(
        control.execute({
          userId: b.f.people.admin.id,
          workspaceId: b.f.workspaceId,
          agentId: b.agentId,
          requestId: crypto.randomUUID(),
          action,
        }),
      ).rejects.toThrow("Agent is not authorized or assigned");
    }
    expect(commands).toEqual([]);
  });
});
