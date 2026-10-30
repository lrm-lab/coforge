import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  CHANNEL_VISIBILITY,
  type ChannelVisibility,
} from "#src/features/conversations/channel-visibility";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import type { ChannelActor } from "#src/server/conversations/channel-access.server";
import { channelActorMemberWhere } from "#src/server/conversations/channel-authority.server";
import {
  canReadChannel,
  readableChannelWhere,
} from "#src/server/conversations/channel-read-access.server";
import { teardown } from "./helpers/workspace-teardown";

/**
 * The read rule for channels (task #302), as a query and in memory, over every kind of reader: a
 * public channel is everyone's; a private one only its active members', the Workspace owner
 * included. Both forms give the same answer for every channel and reader; a hidden channel and a
 * DM are never a channel read; a caller's own `OR` cannot widen the rule; the database refuses a
 * private DM.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "a private channel is readable only by its active members, by query and in memory alike",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const names = ["owner", "member", "leaver", "outsider"] as const;
    const workspace = await db.workspace.create({
      data: {
        slug: `read-${suffix}`,
        name: "Channel read access",
        members: {
          create: names.map((name) => ({
            role: name === "owner" ? "owner" : "member",
            user: { create: { displayName: name, username: `read-${name}-${suffix}` } },
          })),
        },
      },
      include: { members: { include: { user: true } } },
    });
    const people = Object.fromEntries(
      workspace.members.map(({ user }) => [user.displayName, user.id]),
    ) as Record<(typeof names)[number], string>;
    try {
      const agentId = async (name: string) =>
        (
          await db.agent.create({
            data: {
              workspaceId: workspace.id,
              ownerId: people.owner,
              name: `${name}-${suffix}`,
              displayName: name,
              runtimeConfig: {},
            },
          })
        ).id;
      const agents = {
        inside: await agentId("inside"),
        departed: await agentId("departed"),
        outside: await agentId("outside"),
      };
      const roster = [
        { userId: people.member },
        { userId: people.leaver, leftAt: new Date() },
        { agentId: agents.inside },
        { agentId: agents.departed, leftAt: new Date() },
      ];
      const conversation = (
        visibility: ChannelVisibility,
        extra: { channelName?: string; directKey?: string; hiddenFromWorkspaceAt?: Date },
      ) =>
        db.conversation.create({
          data: { workspaceId: workspace.id, visibility, ...extra, members: { create: roster } },
          select: { id: true, visibility: true },
        });
      const open = await conversation("public", { channelName: `open-${suffix}` });
      const closed = await conversation("private", { channelName: `closed-${suffix}` });
      const hidden = await conversation("public", {
        channelName: `hidden-${suffix}`,
        hiddenFromWorkspaceAt: new Date(),
      });
      const direct = await conversation("public", { directKey: `dm-${suffix}` });
      const readers: Record<string, ChannelActor> = {
        member: { userId: people.member },
        leaver: { userId: people.leaver },
        outsider: { userId: people.outsider },
        owner: { userId: people.owner },
        insideAgent: { agentId: agents.inside },
        departedAgent: { agentId: agents.departed },
        outsideAgent: { agentId: agents.outside },
      };
      const readsPrivate = new Set(["member", "insideAgent"]);

      for (const [name, reader] of Object.entries(readers)) {
        const reads = async (id: string) =>
          (await db.conversation.count({
            where: { id, ...readableChannelWhere(workspace.id, reader) },
          })) === 1;
        const activeMember = async (id: string) =>
          (await db.conversationMember.count({
            where: {
              conversationId: id,
              ...channelActorMemberWhere(reader),
              ...ACTIVE_MEMBER_WHERE,
            },
          })) === 1;
        for (const [channel, expected] of [
          [open, true],
          [closed, readsPrivate.has(name)],
        ] as const) {
          const byQuery = await reads(channel.id);
          expect({ name, channel: channel.visibility, byQuery }).toEqual({
            name,
            channel: channel.visibility,
            byQuery: expected,
          });
          expect(canReadChannel(channel, await activeMember(channel.id))).toBe(byQuery);
        }
        expect({ name, hidden: await reads(hidden.id), direct: await reads(direct.id) }).toEqual({
          name,
          hidden: false,
          direct: false,
        });
      }

      // A caller's own OR narrows the read; it never replaces the rule.
      expect(
        await db.conversation.count({
          where: {
            ...readableChannelWhere(workspace.id, readers.outsider!),
            OR: [{ id: closed.id }, { id: open.id }],
          },
        }),
      ).toBe(1);
      // Another Workspace's reads never reach it.
      expect(
        await db.conversation.count({
          where: { id: open.id, ...readableChannelWhere(crypto.randomUUID(), readers.member!) },
        }),
      ).toBe(0);
      // Only a channel can be private.
      const privateDirect = await db.conversation
        .create({
          data: {
            workspaceId: workspace.id,
            directKey: `private-dm-${suffix}`,
            visibility: CHANNEL_VISIBILITY.PRIVATE,
          },
        })
        .then(
          () => "created",
          (error: unknown) => String(error),
        );
      expect(privateDirect).toContain("conversations_visibility_check");
    } finally {
      await teardown(db, workspace.id, Object.values(people));
    }
  },
);
