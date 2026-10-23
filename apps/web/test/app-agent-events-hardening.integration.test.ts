import { expect, test } from "bun:test";

import { createInstallationAgentScope } from "#src/server/app-agent-access/app-agent-access-composition.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { EVENT, db, fixture, useAgentEventsFlag } from "./app-agent-events-fixture";

/** Agent inbound hardening: the installation's Agent scope, the size of an event Message, who reads
 * payloads, request expiry and what an Agent can do to the dedicated conversation. */
useAgentEventsFlag();

const DAY = 24 * 60 * 60 * 1000;

test.skipIf(!db)(
  "narrowing the installation's Agent selection ends the excluded Agent's access",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      expect((await f.event(token, EVENT)).status).toBe(202);
      const scope = createInstallationAgentScope(db!);
      await scope.set({ workspaceId: f.workspace.id, userId: f.owner.id }, f.key, {
        mode: "selected",
        agentIds: [f.other.id],
      });
      // The token it holds stops, and its grant is revoked, so a new request waits for a person.
      expect((await f.event(token, EVENT)).status).toBe(401);
      expect(
        await db!.appAgentInboundGrant.findUniqueOrThrow({
          where: { appId_agentId: { appId: f.app.id, agentId: f.scout.id } },
        }),
      ).toMatchObject({ revokedAt: expect.any(Date) });
      const again = await f.ask(f.scout.id);
      expect(again.body.status).toBe("pending");
      // The Agent still selected keeps working.
      expect((await f.event(await f.tokenFor(f.other.id), EVENT)).status).toBe(202);
      // A person's approval works for an Agent outside the selection.
      await f.inbound.approve(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        { agentId: f.scout.id, requestId: again.body.request_id },
      );
      expect((await f.event(await f.tokenFor(f.scout.id), EVENT)).status).toBe(202);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an automatic grant stops working for an Agent the installation no longer includes, even without the hook",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      await db!.appInstallation.update({
        where: { appId_workspaceId: { appId: f.app.id, workspaceId: f.workspace.id } },
        data: { agentAccess: "selected" },
      });
      expect((await f.event(token, EVENT)).status).toBe(401);
      // The grant is still active in the table, but it does not cover the request any more.
      expect((await f.ask(f.scout.id)).body.status).toBe("pending");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an event whose Message would exceed a message's length is refused, however it is escaped",
  async () => {
    const f = await fixture(db!);
    try {
      const token = await f.tokenFor(f.scout.id);
      // 3,000 characters become 18,000 once each is written as a \u escape.
      const heavy = await f.event(token, { ...EVENT, payload: { x: "@#<>".repeat(750) } });
      expect(heavy.status).toBe(413);
      expect(await db!.appAgentEvent.count({ where: { appId: f.app.id } })).toBe(0);
      expect(
        (await f.event(token, { ...EVENT, payload: { x: "plain ".repeat(300) } })).status,
      ).toBe(202);
      const message = await db!.message.findFirstOrThrow({
        where: { workspaceId: f.workspace.id },
      });
      expect(message.body.length).toBeLessThanOrEqual(8000);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "only those who manage the Agent's app access read an event's payload",
  async () => {
    const f = await fixture(db!);
    try {
      await f.event(await f.tokenFor(f.scout.id), { ...EVENT, payload: { secret: 1 } });
      const manager = await f.inbound.list(
        { workspaceId: f.workspace.id, userId: f.owner.id },
        f.scout.id,
      );
      expect(manager.events[0]!.payload).toEqual({ secret: 1 });
      const reader = await f.inbound.list(
        { workspaceId: f.workspace.id, userId: f.member.id },
        f.scout.id,
      );
      expect(reader.events[0]).toMatchObject({ summary: EVENT.summary, payload: null });
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "a request that nobody used within a day cannot be approved or exchanged",
  async () => {
    const f = await fixture(db!);
    try {
      await db!.app.update({ where: { id: f.app.id }, data: { createdByUserId: f.member.id } });
      const waiting = await f.ask(f.other.id);
      expect(waiting.body.status).toBe("pending");
      const old = new Date(Date.now() - DAY - 1000);
      await db!.appAgentInboundRequest.update({
        where: { id: waiting.body.request_id },
        data: { createdAt: old },
      });
      await expect(
        f.inbound.approve(
          { workspaceId: f.workspace.id, userId: f.owner.id },
          { agentId: f.other.id, requestId: waiting.body.request_id },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await f.exchange(waiting.body.request_id)).body.error).toBe("invalid_grant");
      expect((await f.statusOf(waiting.body.request_id)).body.status).toBe("expired");
      expect(
        (await f.inbound.list({ workspaceId: f.workspace.id, userId: f.owner.id }, f.other.id))
          .pendingRequests,
      ).toEqual([]);
      // The app asks again and gets a new request.
      const fresh = await f.ask(f.other.id);
      expect(fresh.body.status).toBe("pending");
      expect(fresh.body.request_id).not.toBe(waiting.body.request_id);

      // An approved request not exchanged within the day is over too.
      const approved = await f.ask(f.scout.id);
      await db!.app.update({ where: { id: f.app.id }, data: { createdByUserId: f.owner.id } });
      const ready = await f.ask(f.scout.id);
      expect(ready.body.status).toBe("approved");
      await db!.appAgentInboundRequest.update({
        where: { id: ready.body.request_id },
        data: { createdAt: old },
      });
      expect((await f.exchange(ready.body.request_id)).body).toMatchObject({
        error: "invalid_grant",
        error_description: "the request has expired",
      });
      expect(approved.body.request_id).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!db)(
  "an Agent can read and react to an event Message by id, and cannot post into the conversation",
  async () => {
    const f = await fixture(db!);
    try {
      await f.event(await f.tokenFor(f.scout.id), EVENT);
      const message = await db!.message.findFirstOrThrow({
        where: { workspaceId: f.workspace.id },
      });
      const repository = new PrismaDirectConversationRepository(db!);
      const read = await repository.resolveAgentMessage(f.workspace.id, f.scout.id, message.id);
      expect(read.id).toBe(message.id);
      // A reaction is the Agent's own mark in a conversation only it is in: harmless.
      await repository.setAgentMessageReaction(f.workspace.id, f.scout.id, message.id, "👍", true);
      expect(await db!.messageReaction.count({ where: { messageId: message.id } })).toBe(1);
      // Another Agent cannot see the Message by id at all.
      await expect(
        repository.resolveAgentMessage(f.workspace.id, f.other.id, message.id),
      ).rejects.toBeDefined();
      await expect(
        repository.setAgentMessageReaction(f.workspace.id, f.other.id, message.id, "👍", true),
      ).rejects.toBeDefined();
    } finally {
      await f.cleanup();
    }
  },
);
