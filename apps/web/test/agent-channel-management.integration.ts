import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";

function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}

test("Agent channel management: authority, join/leave, archive, and add/remove member", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `mo${suffix}`, username: `mo${suffix}` },
  });
  const outsider = await db.user.create({
    data: { displayName: `mu${suffix}`, username: `mu${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `manage-${suffix}`,
      name: "Channel management",
      members: {
        create: [{ userId: owner.id, role: "owner" }, { userId: outsider.id }],
      },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: crypto.randomUUID() },
    });
    const admin = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `admin${suffix}`,
        displayName: "Admin",
        role: "admin",
        runtimeConfig: {},
      },
    });
    const member = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `member${suffix}`,
        displayName: "Member",
        role: "member",
        runtimeConfig: {},
      },
    });
    // Never joins #eng: used to show add-member's Slack-style "must be a member" denial.
    const outsiderAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `outsideragent${suffix}`,
        displayName: "Outsider Agent",
        role: "member",
        runtimeConfig: {},
      },
    });
    // Never joins #eng either: `server_role` basis grants admin authority independent of
    // membership — "a server admin without membership can still archive".
    const nonMemberServerAdmin = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `nonmemberadmin${suffix}`,
        displayName: "Non-member Admin",
        role: "admin",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const manage = new AgentChannelManagement(db, {
      snapshot: async () => {
        throw new Error("no live display data in this test");
      },
      snapshotMany: async () => {
        throw new Error("no live display data in this test");
      },
    });

    // Authority (Slack's default): any Agent that belongs to the Workspace may
    // create a channel — including a plain, non-admin Agent — the same as `PublicChannels
    // .create` for humans. The creator becomes a member.
    const created = await manage.create(workspace.id, member.id, "#eng", "Engineering");
    expect(created).toEqual({
      target: "#eng",
      channel: { id: expect.any(String), name: "#eng", description: "Engineering" },
    });

    // Any Agent may join a non-archived channel; idempotent. `member` already joined by
    // creating the channel; `admin` joins separately. `alreadyJoined` distinguishes the two.
    const adminJoin = await manage.join(workspace.id, admin.id, "#eng");
    expect(adminJoin).toEqual({ target: "#eng", joined: true, alreadyJoined: false });
    const memberRejoin = await manage.join(workspace.id, member.id, "#eng");
    expect(memberRejoin).toEqual({ target: "#eng", joined: true, alreadyJoined: true });
    await manage.join(workspace.id, member.id, "#eng");
    const info = await manage.info(workspace.id, member.id, "#eng");
    expect(info).toMatchObject({
      name: "#eng",
      description: "Engineering",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 3, humans: 0 },
    });

    // Roster includes the Memory Agent, tagging the caller "self" and the creator "admin". `admin`'s
    // basis is its own server role (`Agent.role`); `member`'s is the `channelRole` it got as
    // #eng's creator — neither is #general, so both bases are reported.
    const roster = await manage.members(workspace.id, member.id, "#eng");
    expect(roster.agents.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        name: admin.name,
        displayName: "Admin",
        description: "",
        serverRole: "admin",
        channelRole: "member",
        channelAdminBasis: "server_role",
        self: false,
        status: "unknown",
      },
      {
        name: member.name,
        displayName: "Member",
        description: "",
        serverRole: "member",
        channelRole: "admin",
        channelAdminBasis: "channel_role",
        self: true,
        status: "unknown",
      },
      {
        name: "memory",
        displayName: "Memory",
        description: "",
        serverRole: "member",
        channelRole: "member",
        channelAdminBasis: undefined,
        self: false,
        status: "unknown",
      },
    ]);

    // Leave, then re-join: the row is soft-left and cleared, not deleted; membership count
    // reflects only active members while left. `wasMember` distinguishes an actual leave from
    // leaving again while already left.
    const memberLeave = await manage.leave(workspace.id, member.id, "#eng");
    expect(memberLeave).toEqual({ target: "#eng", joined: false, wasMember: true });
    const memberLeaveAgain = await manage.leave(workspace.id, member.id, "#eng");
    expect(memberLeaveAgain).toEqual({ target: "#eng", joined: false, wasMember: false });
    expect((await manage.info(workspace.id, member.id, "#eng")).joined).toBe(false);
    expect((await manage.info(workspace.id, admin.id, "#eng")).memberCounts.agents).toBe(2);
    expect(
      await db.conversationMember.count({
        where: { agentId: member.id, conversation: { channelName: "eng" } },
      }),
    ).toBe(1);
    await manage.join(workspace.id, member.id, "#eng");
    expect((await manage.info(workspace.id, member.id, "#eng")).joined).toBe(true);

    // #general cannot be left, renamed, archived, or have a member removed.
    await expect(manage.leave(workspace.id, member.id, "#general")).rejects.toThrow(
      "cannot leave #general",
    );
    await expect(
      manage.update(workspace.id, admin.id, "#general", { name: "renamed" }),
    ).rejects.toThrow("cannot rename #general");
    await expect(manage.setArchived(workspace.id, admin.id, "#general", true)).rejects.toThrow(
      "cannot archive #general",
    );
    await expect(
      manage.removeMember(workspace.id, admin.id, "#general", { agent: `@${member.name}` }),
    ).rejects.toThrow("cannot remove a member from #general");

    // Update requires admin authority (channel-aware) and at least one field; general
    // is reserved. `member` is #eng's creator, so it is itself a channel admin now (channelRole
    // "admin") — `outsiderAgent` (never a member, plain `Agent.role`) exercises the plain
    // denial instead.
    await expect(
      manage.update(workspace.id, outsiderAgent.id, "#eng", { name: "x" }),
    ).rejects.toThrow("this Agent's owner lacks admin authority for update");
    // Positive path for the OTHER basis (`channel_role`): #eng's creator may update
    // its own channel with no server-role admin authority at all.
    const channelRoleUpdate = await manage.update(workspace.id, member.id, "#eng", {
      description: "Updated via channel_role admin",
    });
    expect(channelRoleUpdate.description).toBe("Updated via channel_role admin");
    await expect(manage.update(workspace.id, admin.id, "#eng", {})).rejects.toThrow(
      "update requires --name or --description",
    );
    await expect(
      manage.update(workspace.id, admin.id, "#eng", { name: "general" }),
    ).rejects.toThrow("general is reserved");
    const updated = await manage.update(workspace.id, admin.id, "#eng", {
      description: "Eng team",
    });
    expect(updated.description).toBe("Eng team");

    // Archive/unarchive: admin only (either basis); join and post are refused while archived.
    await expect(manage.setArchived(workspace.id, outsiderAgent.id, "#eng", true)).rejects.toThrow(
      "this Agent's owner lacks admin authority for archive",
    );
    // Positive path for `channel_role` basis: the creator may archive/unarchive its own channel.
    const channelRoleArchived = await manage.setArchived(workspace.id, member.id, "#eng", true);
    expect(channelRoleArchived).toEqual({ target: "#eng", archived: true });
    await manage.setArchived(workspace.id, member.id, "#eng", false);
    const archived = await manage.setArchived(workspace.id, admin.id, "#eng", true);
    expect(archived).toEqual({ target: "#eng", archived: true });
    expect((await manage.info(workspace.id, admin.id, "#eng")).archived).toBe(true);
    // The composer's `#` list still offers an archived channel, with its description and flag.
    expect(
      (await new PublicChannels(db).names(workspace.id, owner.id)).find(
        (channel) => channel.name === "eng",
      ),
    ).toEqual({ id: expect.any(String), name: "eng", description: "Eng team", archived: true });
    await expect(manage.join(workspace.id, admin.id, "#eng")).rejects.toThrow(
      "channel is archived",
    );
    await manage.setArchived(workspace.id, admin.id, "#eng", false);
    expect((await manage.info(workspace.id, admin.id, "#eng")).archived).toBe(false);

    // `server_role` basis needs no membership at all: a server admin who never joined #eng can
    // still archive/unarchive it.
    const nonMemberArchived = await manage.setArchived(
      workspace.id,
      nonMemberServerAdmin.id,
      "#eng",
      true,
    );
    expect(nonMemberArchived).toEqual({ target: "#eng", archived: true });
    await manage.setArchived(workspace.id, nonMemberServerAdmin.id, "#eng", false);

    // add-member (Slack's default): the acting Agent must itself already be an
    // active member of the channel — not gated by Agent.role admin authority, reused from
    // `PublicChannels.addMembers`. Unknown handle 404s; a human must already be a Workspace
    // member (also enforced by the shared method, surfaced as the same 404).
    await expect(
      manage.addMember(workspace.id, outsiderAgent.id, "#eng", { user: `@${outsider.username}` }),
    ).rejects.toThrow("this Agent must be a member of #eng to add members to it");
    await expect(
      manage.addMember(workspace.id, member.id, "#eng", { user: "@nobody" }),
    ).rejects.toThrow("member not found: @nobody");
    const addedHuman = await manage.addMember(workspace.id, member.id, "#eng", {
      user: `@${outsider.username}`,
    });
    expect(addedHuman).toEqual({
      target: "#eng",
      member: { kind: "user", handle: `@${outsider.username}` },
      added: true,
      alreadyMember: false,
    });
    expect((await manage.info(workspace.id, admin.id, "#eng")).memberCounts.humans).toBe(1);
    // Adding the same human again reports alreadyMember.
    const reAddedHuman = await manage.addMember(workspace.id, member.id, "#eng", {
      user: `@${outsider.username}`,
    });
    expect(reAddedHuman).toEqual({
      target: "#eng",
      member: { kind: "user", handle: `@${outsider.username}` },
      added: true,
      alreadyMember: true,
    });

    // remove-member: admin required for another member (`member` is #eng's own channel admin,
    // so `outsiderAgent` exercises the plain denial); self-removal (an Agent removing itself)
    // is allowed without admin authority, the same as `leave`.
    await expect(
      manage.removeMember(workspace.id, outsiderAgent.id, "#eng", {
        user: `@${outsider.username}`,
      }),
    ).rejects.toThrow("this Agent's owner lacks admin authority for remove-member");
    // Positive path for `channel_role` basis: the authority check itself passes for the
    // creator (`wasMember: false` only because `outsiderAgent` never joined #eng).
    const channelRoleRemoval = await manage.removeMember(workspace.id, member.id, "#eng", {
      agent: `@${outsiderAgent.name}`,
    });
    expect(channelRoleRemoval).toEqual({ target: "#eng", removed: true, wasMember: false });
    const removedAgent = await manage.removeMember(workspace.id, member.id, "#eng", {
      agent: `@${member.name}`,
    });
    expect(removedAgent).toEqual({ target: "#eng", removed: true, wasMember: true });
    expect((await manage.info(workspace.id, member.id, "#eng")).joined).toBe(false);
    // Removing an already-left member reports wasMember: false.
    const removedAgentAgain = await manage.removeMember(workspace.id, admin.id, "#eng", {
      agent: `@${member.name}`,
    });
    expect(removedAgentAgain).toEqual({ target: "#eng", removed: true, wasMember: false });
    const removedHuman = await manage.removeMember(workspace.id, admin.id, "#eng", {
      user: `@${outsider.username}`,
    });
    expect(removedHuman).toEqual({ target: "#eng", removed: true, wasMember: true });
    expect((await manage.info(workspace.id, admin.id, "#eng")).memberCounts.humans).toBe(0);

    // members() with an `@user` target looks the DM up read-only; it never creates one as a
    // side effect (unlike `read`/`search`/`send`, which lazily create it via
    // `getOrCreateUserAgent`). No DM exists yet between `admin` and `outsider`, so this 404s.
    await expect(manage.members(workspace.id, admin.id, `@${outsider.username}`)).rejects.toThrow(
      "channel not found",
    );
    expect(
      await db.conversation.findFirst({
        where: { workspaceId: workspace.id, channelName: null },
      }),
    ).toBeNull();

    // Once a DM conversation exists (created here the same way a real `send`/`read` would),
    // members() resolves it and tags the caller "self".
    await new PrismaDirectConversationRepository(db).getOrCreateUserAgent(
      workspace.id,
      owner.id,
      admin.id,
    );
    // A DM is not a named channel, so it has no channel-role concept: `channelRole`/
    // `channelAdminBasis` stay unset for every entry.
    const dmRoster = await manage.members(workspace.id, admin.id, `@${owner.username}`);
    expect(dmRoster).toEqual({
      target: `@${owner.username}`,
      agents: [
        {
          name: admin.name,
          displayName: "Admin",
          description: "",
          serverRole: "admin",
          self: true,
          status: "unknown",
        },
      ],
      humans: [{ username: owner.username, serverRole: "owner" }],
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
    await db.$disconnect();
  }
});
