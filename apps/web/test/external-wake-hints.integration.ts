import { describe, expect, test } from "bun:test";

import { noticeExternalInbox } from "#src/server/agents/external-inbox-landing.server";
import { listWakeHints } from "#src/server/agents/external-wake-hints.server";
import { PrismaExternalPushWebhookStore } from "#src/server/db/repositories/external-agent-push-webhook.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { db as harnessDb, granted, useBotHarness } from "./app-bots-harness";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

if (!harnessDb) throw new Error("CHANNEL_TEST_DATABASE_URL must point at a scratch PostgreSQL");
const db = harnessDb;

useBotHarness();

const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };
const quiet = quietCentrifugo();

async function world() {
  const f = await granted();
  const { agentId } = (await f.botRow())!;
  const scope = { workspaceId: f.workspaceId, agentId };
  const conversations = new PrismaDirectConversationRepository(db);
  const dm = async (body: string) => {
    const member = f.people.member;
    const conversation = await conversations.getOrCreateUserAgent(
      f.workspaceId,
      member.id,
      agentId,
    );
    const row = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: conversation.id, userId: member.id },
    });
    const sent = await new SendDirectMessage(conversations, passThrough, quiet).execute({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      senderMemberId: row.id,
      senderUserId: member.id,
      body,
    });
    return { conversationId: conversation.id, sent };
  };
  const channel = await db.conversation.create({
    data: {
      workspaceId: f.workspaceId,
      channelName: `ops-${f.suffix}`,
      members: { create: [{ userId: f.people.owner.id }, { agentId }] },
    },
  });
  const channels = new PublicChannels(db, passThrough, quiet, undefined, {
    async messageAvailable() {},
    async memberChanged() {},
  });
  const post = (body: string, threadRootId?: string) =>
    channels.send({
      workspaceId: f.workspaceId,
      userId: f.people.owner.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body,
      ...(threadRootId ? { threadRootId } : {}),
    });
  return { f, agentId, scope, dm, channel, post };
}

describe("wake hints", () => {
  test("one hint per reply target, with counts, ids, latest sender and flags", async () => {
    const { f, scope, dm, channel, post } = await world();
    await dm("hello");
    await dm("again");
    const root = await post(`@${f.key} root`);
    await post(`@${f.key} reply`, root.id);
    const hints = await listWakeHints(db, scope);
    const byTarget = new Map(hints.map((hint) => [hint.target, hint]));
    const direct = [...byTarget.values()].find((hint) => hint.channelType === "dm")!;
    expect(direct).toMatchObject({ pendingCount: 2, latestSenderType: "human", flags: ["dm"] });
    expect(direct.target).toBe(`@${f.people.member.username}`);
    const top = byTarget.get(`#ops-${f.suffix}`)!;
    expect(top).toMatchObject({ channelId: channel.id, channelType: "channel", pendingCount: 1 });
    expect(top.flags).toContain("mention");
    const thread = byTarget.get(`#ops-${f.suffix}:${root.id}`)!;
    expect(thread.flags).toContain("thread");
    expect(thread.latestSeq).toMatch(/^\d+$/);
    expect(JSON.stringify(hints)).not.toContain("hello");
  });

  test("a conversation with nothing unread has no hint", async () => {
    const { scope } = await world();
    expect(await listWakeHints(db, scope)).toEqual([]);
  });
});

describe("the landing lookup", () => {
  test("finds a live external Agent that is a member, flags a ready webhook, skips others", async () => {
    const { f, agentId, post, channel } = await world();
    const message = await post(`@${f.key} ping`);
    const woken: string[] = [];
    const enqueued: string[] = [];
    const deps = {
      notify: (id: string) => woken.push(id),
      enqueueNotice: async (id: string) => {
        enqueued.push(id);
      },
    };
    await noticeExternalInbox(db, { conversationId: channel.id, messageId: message.id }, deps);
    expect(woken).toEqual([]);

    await db.agent.update({ where: { id: agentId }, data: { hosting: "external" } });
    await noticeExternalInbox(db, { conversationId: channel.id, messageId: message.id }, deps);
    expect(woken).toEqual([agentId]);
    expect(enqueued).toEqual([]);

    const store = new PrismaExternalPushWebhookStore(db);
    await store.save({
      agentId,
      workspaceId: f.workspaceId,
      url: "https://hooks.example/x",
      secretSealed: "v1.x.y",
    });
    await noticeExternalInbox(db, { conversationId: channel.id, messageId: message.id }, deps);
    expect(enqueued).toEqual([agentId]);

    const row = (await store.find(agentId))!;
    await store.record(agentId, row.revision, {
      lastError: "http_500",
      consecutiveFailures: 1,
      rejectionStreak: 0,
      retryAt: new Date(Date.now() + 60_000),
      retryNoticeId: crypto.randomUUID(),
    });
    await noticeExternalInbox(db, { conversationId: channel.id, messageId: message.id }, deps);
    expect(enqueued).toEqual([agentId]);
    await store.record(agentId, row.revision, {
      lastError: "x",
      consecutiveFailures: 0,
      rejectionStreak: 0,
      retryAt: null,
      retryNoticeId: null,
      disabledReason: "endpoint_rejected",
    });
    await noticeExternalInbox(db, { conversationId: channel.id, messageId: message.id }, deps);
    expect(enqueued).toEqual([agentId]);
  });
});

describe("the push webhook store", () => {
  test("saves, fences attempts by revision, re-enables on a new save and cascades with the Agent", async () => {
    const { f, agentId } = await world();
    const store = new PrismaExternalPushWebhookStore(db);
    await store.save({
      agentId,
      workspaceId: f.workspaceId,
      url: "https://a.example/x",
      secretSealed: "s1",
    });
    const first = (await store.find(agentId))!;
    expect(first).toMatchObject({ revision: 1, enabled: true });
    expect(
      await store.record(agentId, 1, {
        lastError: "http_410",
        consecutiveFailures: 3,
        rejectionStreak: 3,
        retryAt: null,
        retryNoticeId: null,
        disabledReason: "endpoint_rejected",
      }),
    ).toBe(true);
    expect(await store.find(agentId)).toMatchObject({
      enabled: false,
      disabledReason: "endpoint_rejected",
    });
    await store.save({
      agentId,
      workspaceId: f.workspaceId,
      url: "https://b.example/x",
      secretSealed: "s2",
    });
    expect(await store.find(agentId)).toMatchObject({
      revision: 2,
      enabled: true,
      disabledReason: null,
      consecutiveFailures: 0,
      url: "https://b.example/x",
    });
    expect(
      await store.record(agentId, 1, {
        lastError: null,
        consecutiveFailures: 9,
        rejectionStreak: 0,
        retryAt: null,
        retryNoticeId: null,
      }),
    ).toBe(false);
    expect((await store.deliveryTarget(agentId))!.agent.hosting).toBeDefined();
    expect(await store.remove(agentId)).toBe(true);
    expect(await store.find(agentId)).toBeUndefined();
  });
});
