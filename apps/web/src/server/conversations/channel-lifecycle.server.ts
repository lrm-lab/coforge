import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import {
  CHANNEL_VISIBILITY,
  type ChannelVisibility,
} from "#src/features/conversations/channel-visibility";
import { attachmentKeys, removeAttachmentFiles } from "#src/server/attachments/attachment.server";
import { deleteChannelRows } from "#src/server/db/repositories/channel-deletion.repositories.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { getFileStorage, type BulkFileRemoval } from "#src/server/files/file-storage.server";
import { attachDefaultMemoryAgent } from "#src/server/workspace-memory/default-memory-agent.server";
import { isOpenVikingPrototypeEnabled } from "#src/server/workspace-memory/prototype-gate";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { findChannelById, memberChannel, type PublicChannelPorts } from "./channel-access.server";
import { channelActorMemberWhere, type ChannelActor } from "./channel-actor.server";
import {
  canDeleteChannel,
  canHideGeneralChannel,
  isChannelRole,
  resolveActorServerRole,
  resolveChannelAuthority,
} from "./channel-authority.server";
import { setChannelArchived, updateChannelInfo } from "./channel-changes.server";
import { createChannel } from "./channel-creation.server";
import { addChannelMembers } from "./channel-roster.server";
import {
  announceChannelCreated,
  announceChannelTasksDeleted,
  announceChannelUpdated,
  announceViewerEvent,
  channelInfoOf,
} from "./conversation-realtime.server";
import { channelAudience } from "./conversation-signal-scope.server";

/** A channel's life as a whole: creating it, its name, description and member roles, archiving
 * it, hiding `#general` from the Workspace, and deleting a channel for good. */

/** What a new channel may start with besides its name: its project, description and visibility
 * (public unless given). */
export type NewChannelOptions = {
  projectId?: string;
  description?: string;
  visibility?: ChannelVisibility;
};

export async function createUserChannel(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  name: string,
  { projectId, description, visibility }: NewChannelOptions = {},
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  if (!CHANNEL_NAME_PATTERN.test(name)) throw new AppError("INVALID_INPUT");
  // #general is the Workspace's own channel, created with the Workspace.
  if (name === "general") throw new AppError("CONFLICT");
  if (projectId) {
    const project = await db.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true },
    });
    if (!project) throw new AppError("INVALID_INPUT");
  }
  let created: {
    id: string;
    channelName: string | null;
    description: string;
    archivedAt: Date | null;
    visibility: string;
  };
  try {
    created = await createChannel(db, {
      workspaceId,
      name,
      creator: { userId },
      ...(projectId ? { projectId } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(visibility ? { visibility } : {}),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("CONFLICT");
    throw error;
  }
  // Workspace memory is offered to everyone, so its Agent joins a public channel only.
  if (created.visibility === CHANNEL_VISIBILITY.PUBLIC)
    await attachDefaultMemoryAgent(db, {
      workspaceId,
      conversationId: created.id,
      actorUserId: userId,
      now: new Date(),
      gate: { prototypeEnabled: isOpenVikingPrototypeEnabled(Bun.env) },
    });
  await Promise.all([
    announceChannelCreated(realtime, {
      workspaceId,
      conversationId: created.id,
      channel: channelInfoOf(created),
      ...(await channelAudience(db, created)),
    }),
    announceViewerEvent(realtime, {
      userIds: [userId],
      event: { type: "channel.joined.v1", workspaceId, conversationId: created.id },
    }),
  ]);
  return { id: created.id };
}

/**
 * Creates a channel, then adds the people and Agents picked for it through `addMembers`, under
 * the creator's own authority. The channel is not rolled back when the add is refused: the
 * caller gets its id and `membersAddFailed`, and an add refused as a whole adds nobody.
 */
export async function createChannelWithMembers(
  ports: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  input: {
    name: string;
    projectId?: string;
    visibility?: ChannelVisibility;
    userIds: string[];
    agentIds: string[];
  },
): Promise<{ id: string; membersAddFailed: boolean }> {
  const { id } = await createUserChannel(ports, workspaceId, userId, input.name, {
    projectId: input.projectId,
    visibility: input.visibility,
  });
  if (input.userIds.length === 0 && input.agentIds.length === 0)
    return { id, membersAddFailed: false };
  try {
    await addChannelMembers(ports, workspaceId, { userId }, id, {
      userIds: input.userIds,
      agentIds: input.agentIds,
    });
    return { id, membersAddFailed: false };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "channel_create:members_add_failed",
        channelId: id,
        code: isAppError(error) ? error.code : "unknown",
      }),
    );
    return { id, membersAddFailed: true };
  }
}

/**
 * Promotes/demotes a channel member's stored `channelRole`. Human-only: there is
 * no Agent command for changing channel roles (stated in `agent-instructions.ts`). The actor
 * needs `manage_roles` — Workspace owner/admin, or channel
 * admin of this specific channel — and `#general`'s roles are fixed (nobody can be its
 * channel admin), so any role change there is rejected outright.
 */
export async function setChannelRole(
  { db }: PublicChannelPorts,
  workspaceId: string,
  actorUserId: string,
  channelId: string,
  member: ChannelActor,
  role: string,
) {
  const channel = await memberChannel(db, workspaceId, actorUserId, channelId);
  if (channel.channelName === "general") throw new AppError("CONFLICT");
  if (!isChannelRole(role)) throw new AppError("INVALID_INPUT");
  const authority = await resolveChannelAuthority(
    db,
    workspaceId,
    { userId: actorUserId },
    channel,
  );
  if (!authority.capabilities.manage_roles) throw new AppError("ACCESS_DENIED");
  const updated = await db.conversationMember.updateMany({
    where: {
      conversationId: channelId,
      ...channelActorMemberWhere(member),
      ...ACTIVE_MEMBER_WHERE,
    },
    data: { channelRole: role },
  });
  if (updated.count !== 1) throw new AppError("NOT_FOUND");
  return { channelId, channelRole: role };
}

/**
 * Renames a channel or changes its description, for a human from the channel settings panel
 * and for an Agent's `channel update`. Needs the `update` capability (Workspace owner/admin or
 * this channel's admin). The name follows the creation rule and stays unique; `#general` keeps
 * its name but its description can change. An archived channel's info is frozen.
 */
export async function changeChannelInfo(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  patch: { name?: string; description?: string },
) {
  const channel = await findChannelById(db, workspaceId, actor, channelId);
  const authority = await resolveChannelAuthority(db, workspaceId, actor, channel);
  if (!authority.capabilities.update) throw new AppError("ACCESS_DENIED");
  if (channel.archivedAt) throw new AppError("CONFLICT");
  const rename = patch.name !== undefined && patch.name !== channel.channelName;
  const redescribe = patch.description !== undefined && patch.description !== channel.description;
  if (!rename && !redescribe)
    return { id: channel.id, name: channel.channelName!, description: channel.description };
  if (rename) {
    if (channel.channelName === "general") throw new AppError("CONFLICT");
    if (!CHANNEL_NAME_PATTERN.test(patch.name!)) throw new AppError("INVALID_INPUT");
    if (patch.name === "general") throw new AppError("CONFLICT");
  }
  try {
    const updated = await updateChannelInfo(
      db,
      workspaceId,
      channel.id,
      {
        ...(rename ? { channelName: patch.name } : {}),
        ...(redescribe ? { description: patch.description } : {}),
      },
      {
        ...(rename ? { name: patch.name } : {}),
        ...(redescribe ? { description: patch.description } : {}),
      },
    );
    await announceChannelUpdated(realtime, {
      workspaceId,
      conversationId: channel.id,
      channel: channelInfoOf(updated),
      // As the write left it: a visibility change racing this one is announced by its own write.
      ...(await channelAudience(db, { id: channel.id, visibility: updated.visibility })),
    });
    return { id: updated.id, name: updated.channelName!, description: updated.description };
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("CONFLICT");
    throw error;
  }
}

/**
 * Whether `#general` is hidden from the whole Workspace, for the Workspace settings toggle.
 * Owner/admin only, like the change itself.
 */
export async function isGeneralHidden(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const general = await generalForSettings(db, workspaceId, userId);
  return general.hiddenFromWorkspaceAt !== null;
}

/**
 * Hides `#general` from the whole Workspace, or restores it. A Workspace owner or admin does
 * this; while it is hidden nobody, themselves included, sees, reads or posts in it, and its
 * history is kept. Enrollment keeps running meanwhile, so a restore brings everyone back in.
 * Every open sidebar and page hears of the change; a call that changes nothing announces
 * nothing.
 */
export async function setGeneralHidden(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  hidden: boolean,
) {
  const general = await generalForSettings(db, workspaceId, userId);
  if ((general.hiddenFromWorkspaceAt !== null) === hidden) return { id: general.id, hidden };
  const restored = await db.conversation.update({
    where: { id: general.id },
    data: { hiddenFromWorkspaceAt: hidden ? new Date() : null },
    select: { channelName: true, description: true, archivedAt: true, visibility: true },
  });
  await announceChannelUpdated(
    realtime,
    hidden
      ? { workspaceId, conversationId: general.id, gone: true, memberUserIds: undefined }
      : {
          workspaceId,
          conversationId: general.id,
          channel: channelInfoOf(restored),
          // `#general` is never private: the whole Workspace hears of it.
          memberUserIds: undefined,
        },
  );
  return { id: general.id, hidden };
}

/** `#general` as a Workspace setting sees it, hidden or not; only a role that manages every
 * channel may, as `canHideGeneralChannel` says. */
async function generalForSettings(db: PrismaClient, workspaceId: string, userId: string) {
  const role = await resolveActorServerRole(db, workspaceId, { userId });
  if (!canHideGeneralChannel("general", role)) throw new AppError("ACCESS_DENIED");
  const general = await db.conversation.findUnique({
    where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
    select: { id: true, hiddenFromWorkspaceAt: true },
  });
  if (!general) throw new AppError("NOT_FOUND");
  return general;
}

/**
 * Deletes a channel for good: its messages, Tasks, files, memberships and everything else in it
 * go, and Reminders aimed at it (or at its threads) are canceled. A Workspace owner or admin does
 * this — not even the channel's own admin may — and `#general` is never deleted. Its Agents'
 * daemons are told to drop what they hold for it before it goes (the purge resolves the channel
 * by name); afterwards every open sidebar and page hears of it, and its stored files are removed,
 * best effort.
 */
export async function deleteChannel(
  { db, realtime, inboxPurge }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
  storage: () => Promise<BulkFileRemoval> = getFileStorage,
) {
  const [channel, serverRole] = await Promise.all([
    findChannelById(db, workspaceId, { userId }, channelId),
    resolveActorServerRole(db, workspaceId, { userId }),
  ]);
  const name = channel.channelName!;
  if (name === "general") throw new AppError("CONFLICT");
  if (!canDeleteChannel(name, serverRole)) throw new AppError("ACCESS_DENIED");
  // Who hears of the delete is read before the rows that say so are gone.
  const [agentMembers, tasks, objectKeys, audience] = await Promise.all([
    db.conversationMember.findMany({
      where: { conversationId: channel.id, agentId: { not: null }, ...ACTIVE_MEMBER_WHERE },
      select: { agentId: true },
    }),
    db.task.findMany({ where: { conversationId: channel.id }, select: { id: true } }),
    attachmentKeys(db, { conversationId: channel.id }),
    channelAudience(db, channel),
  ]);
  await Promise.all(
    agentMembers.map(({ agentId }) =>
      inboxPurge.purge({
        workspaceId,
        agentId: agentId!,
        conversationIds: [channel.id],
        reason: "member_removed",
      }),
    ),
  );
  await deleteChannelRows(db, {
    workspaceId,
    conversationId: channel.id,
    channelName: name,
  });
  await Promise.all([
    announceChannelUpdated(realtime, {
      workspaceId,
      conversationId: channel.id,
      gone: true,
      ...audience,
    }),
    announceChannelTasksDeleted(realtime, {
      workspaceId,
      conversationId: channel.id,
      deleted: tasks.map(({ id }) => id),
      ...audience,
    }),
  ]);
  await removeAttachmentFiles(objectKeys, storage);
  return { id: channel.id, deleted: true as const };
}

/**
 * Archives or unarchives a channel. Needs the `archive`/`unarchive` capability, which
 * `#general` never grants. Members keep reading an archived channel, but nobody posts in it or
 * joins it until it is unarchived.
 */
export async function changeChannelArchived(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  archived: boolean,
) {
  const channel = await findChannelById(db, workspaceId, actor, channelId);
  if (channel.channelName === "general") throw new AppError("CONFLICT");
  const authority = await resolveChannelAuthority(db, workspaceId, actor, channel);
  if (!authority.capabilities[archived ? "archive" : "unarchive"])
    throw new AppError("ACCESS_DENIED");
  // Already in the asked-for state: nothing to write or announce.
  if ((channel.archivedAt !== null) === archived) return { id: channel.id, archived };
  const changed = await setChannelArchived(db, workspaceId, channel.id, archived);
  await announceChannelUpdated(realtime, {
    workspaceId,
    conversationId: channel.id,
    channel: channelInfoOf(changed),
    // As the write left it: a visibility change racing this one is announced by its own write.
    ...(await channelAudience(db, { id: channel.id, visibility: changed.visibility })),
  });
  return { id: channel.id, archived };
}
