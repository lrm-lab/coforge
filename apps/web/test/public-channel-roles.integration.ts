import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("Channel roles: creator is channel admin, a plain member cannot archive, promote/demote via setChannelRole, server admin without membership, #general's roles are fixed", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const creator = await db.user.create({
    data: { displayName: `rc${suffix}`, username: `rc${suffix}` },
  });
  const plainMember = await db.user.create({
    data: { displayName: `rp${suffix}`, username: `rp${suffix}` },
  });
  const serverAdmin = await db.user.create({
    data: { displayName: `ra${suffix}`, username: `ra${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `roles-${suffix}`,
      name: "Channel roles",
      members: {
        create: [
          { userId: creator.id },
          { userId: plainMember.id },
          // Never joins the channel: proves `server_role` basis needs no membership.
          { userId: serverAdmin.id, role: "admin" },
        ],
      },
    },
  });
  try {
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    await enrollGeneral(db, workspace.id);

    // The creator is the channel's own admin: `channelRole` "admin", basis
    // "channel_role", and every admin capability except on `#general`.
    const channel = await channels.create(workspace.id, creator.id, "roles-eng");
    await channels.join(workspace.id, plainMember.id, channel.id);
    const creatorView = await channels.members(workspace.id, { userId: creator.id }, channel.id);
    expect(creatorView.channelRole).toBe("admin");
    expect(creatorView.channelAdminBasis).toBe("channel_role");
    expect(creatorView.channelCapabilities).toMatchObject({
      update: true,
      archive: true,
      unarchive: true,
      remove_member: true,
      manage_roles: true,
    });
    const creatorRow = creatorView.humans.find((human) => human.id === creator.id);
    expect(creatorRow).toMatchObject({ channelRole: "admin", channelAdminBasis: "channel_role" });

    // A plain member (no admin basis at all) sees no admin capabilities and cannot manage
    // roles or archive.
    const plainView = await channels.members(workspace.id, { userId: plainMember.id }, channel.id);
    expect(plainView.channelRole).toBe("member");
    expect(plainView.channelAdminBasis).toBeUndefined();
    expect(plainView.channelCapabilities).toMatchObject({
      update: false,
      archive: false,
      unarchive: false,
      remove_member: false,
      manage_roles: false,
    });
    await expect(
      channels.setChannelRole(
        workspace.id,
        plainMember.id,
        channel.id,
        { userId: plainMember.id },
        "admin",
      ),
    ).rejects.toThrow("ACCESS_DENIED");

    // Promoting via `setChannelRole` grants channel-admin authority; demoting revokes it.
    await channels.setChannelRole(
      workspace.id,
      creator.id,
      channel.id,
      { userId: plainMember.id },
      "admin",
    );
    const promotedView = await channels.members(
      workspace.id,
      { userId: plainMember.id },
      channel.id,
    );
    expect(promotedView.channelRole).toBe("admin");
    expect(promotedView.channelAdminBasis).toBe("channel_role");
    expect(promotedView.channelCapabilities.archive).toBe(true);

    await channels.setChannelRole(
      workspace.id,
      creator.id,
      channel.id,
      { userId: plainMember.id },
      "member",
    );
    const demotedView = await channels.members(
      workspace.id,
      { userId: plainMember.id },
      channel.id,
    );
    expect(demotedView.channelRole).toBe("member");
    expect(demotedView.channelAdminBasis).toBeUndefined();
    expect(demotedView.channelCapabilities.archive).toBe(false);

    // `server_role` basis needs no membership: `serverAdmin` never joined this channel but
    // still reports full admin capabilities.
    const serverAdminView = await channels.members(
      workspace.id,
      { userId: serverAdmin.id },
      channel.id,
    );
    expect(serverAdminView.channelRole).toBeUndefined();
    expect(serverAdminView.channelAdminBasis).toBe("server_role");
    expect(serverAdminView.channelCapabilities).toMatchObject({
      update: true,
      archive: true,
      unarchive: true,
      remove_member: true,
      manage_roles: true,
    });

    // `#general`'s roles are fixed: nobody can be its channel admin, `setChannelRole` always
    // rejects, and even a server admin's admin capabilities are unavailable there.
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
    });
    await expect(
      channels.setChannelRole(
        workspace.id,
        serverAdmin.id,
        general.id,
        { userId: plainMember.id },
        "admin",
      ),
    ).rejects.toThrow("CONFLICT");
    const generalServerAdminView = await channels.members(
      workspace.id,
      { userId: serverAdmin.id },
      general.id,
    );
    expect(generalServerAdminView.channelAdminBasis).toBe("server_role");
    // A server admin edits #general's description (never its name) and nothing else.
    expect(generalServerAdminView.channelCapabilities).toMatchObject({
      update: true,
      archive: false,
      unarchive: false,
      remove_member: false,
      manage_roles: false,
      leave: false,
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [creator.id, plainMember.id, serverAdmin.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});
