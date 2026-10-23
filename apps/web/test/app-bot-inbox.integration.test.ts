import { describe, expect, test } from "bun:test";

import { handleAppBotEventsGet } from "#src/server/app-bots/app-bot-agent-api.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { db, granted, useBotHarness } from "./app-bots-harness";

/**
 * The bot's inbox over `GET /api/agent/v1/events` against local PostgreSQL: a pull takes nothing,
 * the cursor it returns acknowledges what it covered when handed back as `since`, and a replayed
 * or foreign cursor is harmless or refused.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
useBotHarness();

const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };
const quiet = {
  async publish() {},
  async publishJson() {},
} as unknown as CentrifugoServerApi;

async function inbox() {
  const f = await granted();
  const { agentId } = (await f.botRow())!;
  const principal = { workspaceId: f.workspaceId, agentId };
  const check = async (query = "") => {
    const response = await handleAppBotEventsGet(
      new Request(`https://coforge.test/api/agent/v1/events${query}`),
      principal,
      db!,
    );
    return { status: response.status, body: await response.json() };
  };
  const conversations = new PrismaDirectConversationRepository(db!);
  const dm = async (body: string) => {
    const member = f.people.member;
    const conversation = await conversations.getOrCreateUserAgent(
      f.workspaceId,
      member.id,
      agentId,
    );
    const row = await db!.conversationMember.findFirstOrThrow({
      where: { conversationId: conversation.id, userId: member.id },
    });
    await new SendDirectMessage(conversations, passThrough, quiet).execute({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: f.workspaceId,
      conversationId: conversation.id,
      senderMemberId: row.id,
      senderUserId: member.id,
      body,
    });
    return conversation.id;
  };
  return { f, agentId, check, dm };
}

const bodies = (result: { body: { events: { body: string }[] } }) =>
  result.body.events.map((event) => event.body);

describe.skipIf(!db)("a bot's inbox", () => {
  test("a pull takes nothing: the same messages come again until the cursor is handed back", async () => {
    const { agentId, check, dm } = await inbox();
    const conversationId = await dm("first");
    const first = await check();
    expect(bodies(first)).toEqual(["first"]);
    expect(first.body.cursor).toEqual(expect.any(String));
    expect(bodies(await check())).toEqual(["first"]);
    const member = await db!.conversationMember.findFirstOrThrow({
      where: { conversationId, agentId },
    });
    expect(member.agentReadThroughSequence).toBe(0);

    const acknowledged = await check(`?since=${first.body.cursor}`);
    expect(acknowledged.body.events).toEqual([]);
    expect(
      (await db!.conversationMember.findUniqueOrThrow({ where: { id: member.id } }))
        .agentReadThroughSequence,
    ).toBe(1);
  });

  test("a cursor acknowledges only what it covered; later messages are still waiting", async () => {
    const { check, dm } = await inbox();
    await dm("one");
    const first = await check();
    await dm("two");
    const next = await check(`?since=${first.body.cursor}`);
    expect(bodies(next)).toEqual(["two"]);
    // Replaying the old cursor changes nothing and loses nothing.
    expect(bodies(await check(`?since=${first.body.cursor}`))).toEqual(["two"]);
    expect(bodies(await check(`?since=${next.body.cursor}`))).toEqual([]);
  });

  test("channel messages and a thread reply are acknowledged by their own boundaries", async () => {
    const { f, agentId, check } = await inbox();
    const channel = await db!.conversation.create({
      data: {
        workspaceId: f.workspaceId,
        channelName: `ops-${f.suffix}`,
        members: { create: [{ userId: f.people.owner.id }, { agentId }] },
      },
    });
    const channels = new PublicChannels(db!, passThrough, quiet, undefined, {
      async messageAvailable() {},
      async memberChanged() {},
    });
    const send = (body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: f.workspaceId,
        userId: f.people.owner.id,
        channelId: channel.id,
        idempotencyKey: crypto.randomUUID(),
        body,
        ...(threadRootId ? { threadRootId } : {}),
      });
    const root = await send(`@${f.key} root`);
    await send(`@${f.key} reply`, root.id);
    const first = await check();
    expect(bodies(first)).toHaveLength(2);
    expect(bodies(first).some((body) => body.endsWith("root"))).toBe(true);
    expect(bodies(first).some((body) => body.endsWith("reply"))).toBe(true);
    expect((await check(`?since=${first.body.cursor}`)).body.events).toEqual([]);
  });

  test("limit pages the inbox and hasMore says so", async () => {
    const { check, dm } = await inbox();
    await dm("a");
    await dm("b");
    const page = await check("?limit=1");
    expect(page.body.events).toHaveLength(1);
    expect(page.body.hasMore).toBe(true);
    const rest = await check(`?limit=1&since=${page.body.cursor}`);
    expect(rest.body.events).toHaveLength(1);
    expect(bodies(rest)).not.toEqual(bodies(page));
  });

  test("a cursor that is not one of ours, or a bad limit, is 400", async () => {
    const { check } = await inbox();
    expect((await check("?since=not-a-cursor")).status).toBe(400);
    const forged = Buffer.from(JSON.stringify({ groups: [["x", null, 1]], outside: [] })).toString(
      "base64url",
    );
    expect((await check(`?since=${forged}`)).status).toBe(400);
    expect((await check("?limit=abc")).status).toBe(400);
  });

  test("a cursor never moves another conversation's boundary", async () => {
    const a = await inbox();
    const b = await inbox();
    const conversationId = await b.dm("other app's");
    const forged = Buffer.from(
      JSON.stringify({ groups: [[conversationId, null, 99]], outside: [] }),
    ).toString("base64url");
    await a.check(`?since=${forged}`);
    const member = await db!.conversationMember.findFirstOrThrow({
      where: { conversationId, agentId: b.agentId },
    });
    expect(member.agentReadThroughSequence).toBe(0);
  });
});
