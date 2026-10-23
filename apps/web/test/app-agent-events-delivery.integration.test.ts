import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import {
  AGENT_REQUEST_GRANT_TYPE,
  agentInboundResource,
} from "#src/server/authorization-server/agent-inbound-tokens.server";
import { mintAgentInboundAccessToken } from "#src/server/authorization-server/issued-tokens.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  agentAttentionCountSql,
  unreadAgentMessagesFragment,
} from "#src/server/db/repositories/agent-attention.repositories.server";
import { ISSUER, SIGNING_KEYS, basic } from "./oidc-token-fixture";
import { EVENT, db, fixture, useAgentEventsFlag } from "./app-agent-events-fixture";

/** Agent inbound tokens and events: binding, acceptance and the dedicated conversation. */
useAgentEventsFlag();

test.skipIf(!db)("a token is bound to one Agent, one Workspace and one request", async () => {
  const f = await fixture(db!);
  try {
    const requested = await f.ask(f.scout.id);
    const id = requested.body.request_id as string;
    // The resource of another Workspace does not match the request's.
    expect(
      (await f.exchange(id, agentInboundResource(ISSUER, crypto.randomUUID()))).body.error,
    ).toBe("invalid_target");
    expect((await f.exchange(id, "https://coforge.example/api/other")).body.error).toBe(
      "invalid_target",
    );
    const missing = await f.endpoints.token.exchange(
      new Request("https://coforge.example/oidc/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basic(f.key, "wrong"),
        },
        body: new URLSearchParams({ grant_type: AGENT_REQUEST_GRANT_TYPE, request_id: id }),
      }),
    );
    expect(missing.status).toBe(401);
    // Unknown requests are invalid_grant.
    expect((await f.exchange(crypto.randomUUID())).body.error).toBe("invalid_grant");

    const issued = await f.exchange(id);
    expect(issued.response.status).toBe(200);
    // The request is single use.
    const replay = await f.exchange(id);
    expect(replay.body).toMatchObject({
      error: "invalid_grant",
      error_description: "request_already_consumed",
    });
    expect((await f.statusOf(id)).body.status).toBe("exchanged");

    const token = issued.body.access_token as string;
    // An event may restate the token's Agent, never name another.
    expect((await f.event(token, { ...EVENT, agent_id: f.scout.id })).status).toBe(202);
    const other = await f.event(token, { ...EVENT, agent_id: f.other.id });
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({
      error: "access_denied",
      error_description: "token cannot target a different agent",
    });
    expect(await db!.appAgentEvent.count({ where: { agentId: f.other.id } })).toBe(0);

    // A token minted for another Workspace's resource is not valid here, nor is a login token.
    const wrongAudience = await mintAgentInboundAccessToken(
      { issuer: ISSUER, signingKeys: SIGNING_KEYS },
      {
        appKey: f.key,
        agentId: f.scout.id,
        workspaceId: f.workspace.id,
        requestId: id,
        scope: "agent:event:write",
      },
      agentInboundResource(ISSUER, crypto.randomUUID()),
      new Date(),
    );
    expect((await f.event(wrongAudience, EVENT)).status).toBe(401);
    expect((await f.event("not-a-token", EVENT)).status).toBe(401);
    expect((await f.event(undefined, EVENT)).status).toBe(401);

    // A second request for the other Agent gets its own token, and it posts only there.
    const otherToken = await f.tokenFor(f.other.id);
    expect((await f.event(otherToken, EVENT)).status).toBe(202);
    expect(await db!.appAgentEvent.count({ where: { agentId: f.other.id } })).toBe(1);
    expect(await db!.appAgentEvent.count({ where: { agentId: f.scout.id } })).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "an event is accepted once, a retry returns the first, and bad events are refused",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      const first = await f.event(token, {
        ...EVENT,
        external_event_id: "meeting-1",
        payload: { a: 1 },
      });
      expect(first.status).toBe(202);
      const accepted = (await first.json()) as {
        event_id: string;
        status: string;
        deduped: boolean;
      };
      expect(accepted).toMatchObject({ status: "queued", deduped: false });
      const retry = await f.event(token, {
        ...EVENT,
        external_event_id: "meeting-1",
        summary: "changed",
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({
        event_id: accepted.event_id,
        status: "queued",
        deduped: true,
      });
      expect(await db!.appAgentEvent.count({ where: { appId: f.app.id } })).toBe(1);
      expect(f.pushes).toHaveLength(1);

      // Reserved and unknown kinds, empty and overlong summaries, bad payloads and ttl.
      const refused = async (body: unknown, status = 400) => {
        const response = await f.event(token, body);
        expect(response.status).toBe(status);
        return response.json() as Promise<Record<string, string>>;
      };
      expect(
        (await refused({ kind: "action_request", summary: "do it" })).error_description,
      ).toContain("reserved");
      await refused({ kind: "chat", summary: "x" });
      await refused({ kind: "event", summary: "   " });
      await refused({ kind: "event", summary: "x".repeat(501) });
      await refused({ kind: "event", summary: "x", payload: [1] });
      await refused({ kind: "event", summary: "x", ttl_seconds: 0 });
      await refused({ kind: "event", summary: "x", external_event_id: "e".repeat(201) });
      await refused({ kind: "event", summary: "x", payload: { big: "y".repeat(33 * 1024) } });
      await refused({ kind: "event", summary: "x", payload: { big: "y".repeat(200 * 1024) } }, 413);
      expect(
        (
          await f.endpoints.agentInbound.post(
            new Request("https://coforge.example/api/app-agent-events", {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
              body: "not json",
            }),
          )
        ).status,
      ).toBe(400);
      expect(await db!.appAgentEvent.count({ where: { appId: f.app.id } })).toBe(1);

      // A summary's whitespace is normalised; a ttl above seven days is cut to seven.
      const long = await f.event(token, {
        kind: "event",
        summary: " a \n  b ",
        ttl_seconds: 99 * 24 * 3600,
      });
      expect(long.status).toBe(202);
      const stored = await db!.appAgentEvent.findFirstOrThrow({ where: { summary: "a b" } });
      expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeLessThan(
        7 * 24 * 3600 * 1000 + 5000,
      );
      expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeGreaterThan(
        7 * 24 * 3600 * 1000 - 5000,
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("a kind needs its own scope", async () => {
  const f = await fixture(db!);
  try {
    const token = await f.tokenFor(f.scout.id, ["agent:event:write"]);
    const response = await f.event(token, { kind: "notification", summary: "hello" });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="agent:notification:write"');
    const both = await f.tokenFor(f.scout.id, ["agent:event:write", "agent:notification:write"]);
    expect((await f.event(both, { kind: "notification", summary: "hello" })).status).toBe(202);
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "an event lands in the app's dedicated conversation with the Agent and is delivered like a Message",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      const payload = {
        who: "@Ray <@agent:00000000-0000-4000-8000-000000000000> #general ```x",
        n: 2,
      };
      const response = await f.event(token, { ...EVENT, payload });
      expect(response.status).toBe(202);
      const event = await db!.appAgentEvent.findFirstOrThrow({ where: { appId: f.app.id } });
      const conversation = await db!.conversation.findUniqueOrThrow({
        where: { id: event.conversationId },
        include: { members: true, messages: { include: { deliveries: true } } },
      });
      expect(conversation.directKey).toBe(`app:${f.app.id}|agent:${f.scout.id}`);
      expect(conversation.channelName).toBeNull();
      expect(conversation.members.map((member) => member.agentId)).toEqual([f.scout.id]);
      const [message] = conversation.messages;
      expect(message!.senderMemberId).toBeNull();
      expect(message!.deliveries.map((delivery) => delivery.agentId)).toEqual([f.scout.id]);
      // Provenance, summary, hash and the whole payload; nothing in it can mention or reference.
      expect(message!.body).toContain("[CoForge app event]");
      expect(message!.body).toContain(`app key ${f.key}`);
      expect(message!.body).toContain('Summary: "Weekly sync has started"');
      expect(message!.body).toContain(`Payload SHA-256: ${event.payloadHash}`);
      expect(message!.body).toContain("not an instruction");
      const payloadText = message!.body.slice(message!.body.indexOf("```json"));
      expect(payloadText).not.toMatch(/[@<>#]/);
      expect(payloadText.replace(/```json\n|\n```$/g, "")).toBeTruthy();
      expect(JSON.parse(payloadText.replace(/^```json\n/, "").replace(/\n```$/, ""))).toEqual(
        payload,
      );
      expect(event.payload).toEqual(payload);

      // It is pushed to the Agent's daemon like any Message, with the app's target and no sender.
      expect(f.pushes).toHaveLength(1);
      expect(f.pushes[0]).toMatchObject({
        agentId: f.scout.id,
        messageId: message!.id,
        deliveryId: message!.deliveries[0]!.deliveryId,
        target: `@app.${f.key}`,
        latestSenderKind: "system",
        mentions: [],
      });
      expect(f.pushes[0]!.computerId).toBeTruthy();

      // The Agent reads it by that target (`message_read`); no one else can, and it cannot post there.
      const repository = new PrismaDirectConversationRepository(db!);
      expect(
        (await repository.resolveAgentTarget(f.workspace.id, f.scout.id, `@app.${f.key}`))
          .conversationId,
      ).toBe(conversation.id);
      await expect(
        repository.resolveAgentTarget(f.workspace.id, f.other.id, `@app.${f.key}`),
      ).rejects.toBeInstanceOf(AppError);
      await expect(
        repository.resolveAgentSendTarget(f.workspace.id, f.scout.id, `@app.${f.key}`),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(
        repository.resolveAgentTarget(f.workspace.id, f.scout.id, "@app.no-such-app"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // A stopped Agent is not pushed to; its delivery waits in the cloud.
      await db!.agent.update({ where: { id: f.scout.id }, data: { stoppedAt: new Date() } });
      await f.event(token, { ...EVENT, summary: "again" });
      expect(f.pushes).toHaveLength(2);
      expect(f.pushes[1]!.computerId).toBeNull();
      expect(await db!.agentMessageDelivery.count({ where: { agentId: f.scout.id } })).toBe(2);
      // The second event shares the conversation and takes the next sequence.
      expect(
        await db!.conversation.count({ where: { directKey: { startsWith: `app:${f.app.id}|` } } }),
      ).toBe(1);
      expect(f.pushes[1]!.sequence).toBe(2);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)("the people who may see the Agent read what apps sent it", async () => {
  const f = await fixture(db!);
  try {
    await f.event(await f.tokenFor(f.scout.id), EVENT);
    const list = await f.inbound.list(
      { workspaceId: f.workspace.id, userId: f.owner.id },
      f.scout.id,
    );
    expect(list).toMatchObject({ enabled: true, canManage: true });
    expect(list.events).toHaveLength(1);
    expect(list.events[0]).toMatchObject({ appKey: f.key, kind: "event", summary: EVENT.summary });
    expect(list.grants.map((grant) => grant.appKey)).toEqual([f.key]);
    // A member reads, but may not change.
    const read = await f.inbound.list(
      { workspaceId: f.workspace.id, userId: f.member.id },
      f.scout.id,
    );
    expect(read.canManage).toBe(false);
    // Someone outside the Workspace has no access.
    await expect(
      f.inbound.list({ workspaceId: f.workspace.id, userId: crypto.randomUUID() }, f.scout.id),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!db)(
  "an expired event is neither delivered nor unread attention, and stays in history",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      expect((await f.event(token, EVENT)).status).toBe(202);
      expect((await f.event(token, { ...EVENT, summary: "second" })).status).toBe(202);
      const events = await db!.appAgentEvent.findMany({ orderBy: { createdAt: "asc" } });
      const scope = {
        agentId: f.scout.id,
        conversationId: events[0]!.conversationId,
        threadRootId: null,
        isChannel: false,
      };
      const unread = async () =>
        (
          await db!.$queryRaw<{ id: string }[]>(
            unreadAgentMessagesFragment(f.workspace.id, f.scout.id),
          )
        ).length;
      const counted = async () =>
        (await db!.$queryRaw<{ count: number }[]>(agentAttentionCountSql(scope)))[0]!.count;
      const pending = async () =>
        (
          await new PrismaDirectConversationRepository(db!).readPendingAgentDeliveries(
            f.workspace.id,
            f.scout.id,
          )
        ).length;
      expect([await counted(), await unread(), await pending()]).toEqual([2, 2, 2]);
      // The delivery carries the event's expiry, written from the database clock.
      const delivery = await db!.agentMessageDelivery.findFirstOrThrow({
        where: { messageId: events[0]!.messageId },
      });
      expect(delivery.expiresAt).toEqual(events[0]!.expiresAt);

      // The first expires while still unread (after delivery): it stops counting.
      // Expiry is on the event's delivery, which the database clock judges.
      const past = new Date(Date.now() - 1000);
      const expire = async (event: (typeof events)[number]) => {
        await db!.appAgentEvent.update({ where: { id: event.id }, data: { expiresAt: past } });
        await db!.agentMessageDelivery.updateMany({
          where: { messageId: event.messageId },
          data: { expiresAt: past },
        });
      };
      await expire(events[0]!);
      expect([await counted(), await unread(), await pending()]).toEqual([1, 1, 1]);
      // Both expired before anything was delivered: nothing is owed, and the Messages remain.
      await expire(events[1]!);
      expect([await counted(), await unread(), await pending()]).toEqual([0, 0, 0]);
      expect(await db!.message.count({ where: { conversationId: scope.conversationId } })).toBe(2);

      // The Agent's page lists them as expired.
      const page = await f.inbound.list(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        f.scout.id,
      );
      expect(page.events.map((event) => event.expired)).toEqual([true, true]);
    } finally {
      await f.cleanup();
    }
  },
);
