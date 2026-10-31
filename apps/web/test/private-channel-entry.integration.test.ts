import { expect, test } from "bun:test";
import {
  cachedActivityAudience,
  prismaActivityAudienceReads,
} from "#src/server/agents/agent-activity-audience.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { forgetChannelPeopleWith } from "#src/server/conversations/channel-people-invalidation.server";
import type {
  ChannelCreatedSignal,
  ChannelUpdatedSignal,
  ConversationRealtime,
  RevokedConversations,
} from "#src/server/conversations/conversation-realtime.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";
import {
  connectionString,
  errorOf,
  privateChannelFixture,
  type PrivateChannelFixture,
} from "./helpers/private-channel-fixture";

/**
 * Task #302's entry: a channel is created private by a person, an Agent or an action card, and a
 * Workspace owner or admin in a channel turns it private or public. Turned private, everyone
 * outside it loses it at once; turned public, everyone reads it. Drives the real services against
 * local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */

function recording() {
  const created: Pick<ChannelCreatedSignal, "conversationId" | "memberUserIds" | "channel">[] = [];
  const updated: Pick<
    ChannelUpdatedSignal,
    "conversationId" | "memberUserIds" | "channel" | "gone"
  >[] = [];
  const revoked: RevokedConversations[] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged() {},
    async viewerChanged() {},
    async channelCreated({ conversationId, memberUserIds, channel }) {
      created.push({ conversationId, memberUserIds: sorted(memberUserIds), channel });
    },
    async channelUpdated({ conversationId, memberUserIds, channel, gone }) {
      updated.push({
        conversationId,
        memberUserIds: sorted(memberUserIds),
        ...(channel ? { channel } : {}),
        ...(gone ? { gone } : {}),
      });
    },
    async revokeConversations(input) {
      revoked.push(input);
    },
  };
  return { created, updated, revoked, realtime };
}

const sorted = (ids: readonly string[] | undefined) => (ids ? [...ids].sort() : ids);

async function agentOf(
  { db, ws, people, suffix }: PrivateChannelFixture,
  name: string,
  role: "member" | "admin",
  channelIds: string[],
) {
  return db.agent.create({
    data: {
      workspaceId: ws,
      name: `${name}-${suffix}`,
      displayName: name,
      ownerId: people.insider,
      role,
      runtimeConfig: {},
      conversations: {
        create: channelIds.map((conversationId) => ({ conversationId })),
      },
    },
  });
}

test.skipIf(!connectionString)(
  "a person, an Agent and a card create a private channel its members alone read, without the memory Agent",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, people, suffix, open } = fixture;
    const { created, realtime } = recording();
    const channels = new PublicChannels(db, undefined, quietCentrifugo(), undefined, realtime, {
      purge: async () => {},
    });
    const scout = await agentOf(fixture, "scout", "member", [open.id]);
    try {
      const byPerson = (
        await channels.create(ws, people.insider, `by-person-${suffix}`, { visibility: "private" })
      ).id;
      const byAgent = await new AgentChannelManagement(db, undefined, channels, realtime, {
        purge: async () => {},
      }).create(ws, scout.id, `by-agent-${suffix}`, { visibility: "private" });
      expect(byAgent.channel.visibility).toBe("private");
      const cards = new ActionCards(db, new PrismaDirectConversationRepository(db), realtime);
      const { messageId } = await cards.prepare(
        { workspaceId: ws, agentId: scout.id },
        {
          target: `#${open.name}`,
          action: { type: "channel:create", name: `by-card-${suffix}`, visibility: "private" },
        },
      );
      const byCard = (
        await cards.commitChannelCreate(
          { workspaceId: ws, actorUserId: people.insider },
          { messageId, name: `by-card-${suffix}`, memberUserIds: [], memberAgentIds: [] },
        )
      ).channelId;

      for (const id of [byPerson, byAgent.channel.id, byCard]) {
        const row = await db.conversation.findUniqueOrThrow({ where: { id } });
        expect(row.visibility).toBe("private");
        for (const userId of [people.owner, people.outsider])
          expect(await errorOf(channels.open(ws, userId, id))).toBe("NOT_FOUND");
      }
      expect(await errorOf(channels.open(ws, people.insider, byPerson))).toBeUndefined();
      // Announced to its people only: the creator, or nobody for an Agent's.
      expect(
        created.map(({ conversationId, memberUserIds }) => [conversationId, memberUserIds]),
      ).toEqual([
        [byPerson, [people.insider]],
        [byAgent.channel.id, []],
        [byCard, [people.insider]],
      ]);
      expect(created.every(({ channel }) => channel.visibility === "private")).toBe(true);

      // No memory Agent joined any of them; a public channel still gets one.
      expect(await db.workspaceMemoryAgent.findUnique({ where: { workspaceId: ws } })).toBeNull();
      const visible = (await channels.create(ws, people.insider, `by-all-${suffix}`)).id;
      const memory = await db.workspaceMemoryAgent.findUniqueOrThrow({
        where: { workspaceId: ws },
      });
      expect(
        await db.conversationMember.count({
          where: { agentId: memory.agentId, conversationId: { in: [visible] } },
        }),
      ).toBe(1);
      expect(
        await db.conversationMember.count({
          where: { agentId: memory.agentId, conversationId: { not: visible } },
        }),
      ).toBe(0);
    } finally {
      await fixture.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "only a Workspace owner or admin in the channel changes its visibility; #general and archived ones never",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, people, open, closed, vault } = fixture;
    const { created, updated, revoked, realtime } = recording();
    const channels = new PublicChannels(db, undefined, quietCentrifugo(), undefined, realtime, {
      purge: async () => {},
    });
    const general = await db.conversation.create({
      data: {
        workspaceId: ws,
        channelName: "general",
        members: { create: [{ userId: people.owner }, { userId: people.insider }] },
      },
    });
    const set = (userId: string, channelId: string, visibility: "public" | "private") =>
      errorOf(channels.setVisibility(ws, { userId }, channelId, visibility));
    try {
      // A channel admin is not enough, nor is being outside a public one.
      expect(await set(people.insider, open.id, "private")).toBe("ACCESS_DENIED");
      expect(await set(people.outsider, open.id, "private")).toBe("ACCESS_DENIED");
      // A private channel an owner is not in is missing, as for any read.
      expect(await set(people.owner, closed.id, "public")).toBe("NOT_FOUND");
      expect(await set(people.owner, general.id, "private")).toBe("CONFLICT");

      await db.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: ws, userId: people.insider } },
        data: { role: "admin" },
      });
      expect(await set(people.insider, vault.id, "public")).toBe("CONFLICT");
      expect(
        await channels.setVisibility(ws, { userId: people.insider }, closed.id, "private"),
      ).toEqual({ changed: false });
      expect([created, updated, revoked]).toEqual([[], [], []]);

      // An Agent goes by its own Workspace role, inside the channel, as a person does.
      const manage = new AgentChannelManagement(db, undefined, channels, realtime, {
        purge: async () => {},
      });
      const status = (agentId: string, target: string, name?: string) =>
        manage.update(ws, agentId, target, { name, visibility: "private" }).then(
          () => 200,
          (error: { status?: number }) => error.status,
        );
      const plain = await agentOf(fixture, "plain", "member", [open.id]);
      // A channel admin by its seat, a member of the Workspace by its role.
      const chief = await agentOf(fixture, "chief", "member", [open.id]);
      await db.conversationMember.updateMany({
        where: { conversationId: open.id, agentId: chief.id },
        data: { channelRole: "admin" },
      });
      const admin = await agentOf(fixture, "boss", "admin", [open.id]);
      const away = await agentOf(fixture, "away", "admin", []);
      expect(await status(plain.id, `#${open.name}`)).toBe(403);
      // Denied before anything is written: the name it asked for too is not taken.
      expect(await status(chief.id, `#${open.name}`, "renamed")).toBe(403);
      expect(
        (await db.conversation.findUniqueOrThrow({ where: { id: open.id } })).channelName,
      ).toBe(open.name);
      expect(await status(away.id, `#${closed.name}`)).toBe(404);
      expect(await status(away.id, `#${open.name}`)).toBe(403);
      expect(await status(admin.id, "#general")).toBe(400);
      expect(await status(admin.id, `#${open.name}`)).toBe(200);
      expect((await db.conversation.findUniqueOrThrow({ where: { id: open.id } })).visibility).toBe(
        "private",
      );
    } finally {
      await fixture.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "made private, everyone outside loses it at once; made public, everyone reads it again",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, people, board, history, open } = fixture;
    const { created, updated, revoked, realtime } = recording();
    const channels = new PublicChannels(db, undefined, quietCentrifugo(), undefined, realtime, {
      purge: async () => {},
    });
    // The live Activity audience, told of the change as the real one is.
    const audience = cachedActivityAudience(prismaActivityAudienceReads(() => db));
    forgetChannelPeopleWith(audience.forget);
    const liveTo = async () =>
      sorted(
        await audience.audience(
          { workspaceId: ws, agentId: "agent", conversationId: open.id },
          async () => ({ visibility: "public", ownerId: people.owner, systemKind: null }),
        ),
      );
    const reads = (userId: string) =>
      Promise.all([
        errorOf(channels.open(ws, userId, open.id)),
        errorOf(history.loadThread(ws, userId, open.id, open.message.id)),
        // A Task outside what one reads is no Task.
        board
          .overviewTask({ workspaceId: ws, userId }, { conversationId: open.id, number: 1 })
          .then((task) => (task ? undefined : "NOT_FOUND")),
        errorOf(
          readAuthorizedAttachment(db, {
            attachmentId: open.attachment.id,
            workspaceId: ws,
            userId,
          }),
        ),
      ]);
    const members = sorted([people.owner, people.insider]);
    // A Task's own conversation goes with its channel.
    const discussion = await db.conversation.create({
      data: { workspaceId: ws, kind: "task_thread" },
    });
    await db.task.update({
      where: { id: open.message.id },
      data: { discussionConversationId: discussion.id },
    });
    try {
      expect(await liveTo()).toBeUndefined();
      expect(
        await channels.setVisibility(ws, { userId: people.owner }, open.id, "private"),
      ).toEqual({ changed: true });

      expect(await reads(people.outsider)).toEqual([
        "NOT_FOUND",
        "NOT_FOUND",
        "NOT_FOUND",
        "NOT_FOUND",
      ]);
      expect(await reads(people.insider)).toEqual([undefined, undefined, undefined, undefined]);
      expect(revoked).toEqual([
        { conversationIds: [open.id, discussion.id], userIds: [people.outsider] },
      ]);
      expect(updated.splice(0)).toEqual(
        expect.arrayContaining([
          { conversationId: open.id, memberUserIds: [people.outsider], gone: true },
          {
            conversationId: open.id,
            memberUserIds: members,
            channel: expect.objectContaining({ visibility: "private" }),
          },
        ]),
      );
      expect(await liveTo()).toEqual(members);

      expect(await channels.setVisibility(ws, { userId: people.owner }, open.id, "public")).toEqual(
        { changed: true },
      );
      expect(await reads(people.outsider)).toEqual([undefined, undefined, undefined, undefined]);
      const info = expect.objectContaining({ visibility: "public" });
      expect(created).toEqual([
        { conversationId: open.id, memberUserIds: undefined, channel: info },
      ]);
      expect(updated).toEqual([
        { conversationId: open.id, memberUserIds: undefined, channel: info },
      ]);
      expect(revoked).toHaveLength(1);
      expect(await liveTo()).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  },
);
