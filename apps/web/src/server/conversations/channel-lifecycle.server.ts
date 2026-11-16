import { LIVE_TASK_WHERE } from "#src/server/tasks/task-view.server";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { type ChannelVisibility } from "#src/features/conversations/channel-visibility";
import { attachmentKeys, removeAttachmentFiles } from "#src/server/attachments/attachment.server";
import { deleteChannelRows } from "#src/server/db/repositories/channel-deletion.repositories.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { getFileStorage, type BulkFileRemoval } from "#src/server/files/file-storage.server";
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
import type { ChannelMember } from "#src/server/app-notifications/channel-events.server";
import { addChannelMembers } from "./channel-roster.server";
import {
  announceChannelCreated,
  announceChannelTasksDeleted,
  announceChannelUpdated,
  announceViewerEvent,
  channelInfoOf,
} from "./conversation-realtime.server";
import { channelAudience } from "./conversation-signal-scope.server";
export type NewChannelOptions = {
  description?: string;
  visibility?: ChannelVisibility;
  members?: readonly ChannelMember[];
};
export async function createUserChannel(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  name: string,
  { description, visibility, members }: NewChannelOptions = {},
) {
  await requireWorkspaceMember(db, workspaceId, userId);
  if (!CHANNEL_NAME_PATTERN.test(name)) throw new AppError("INVALID_INPUT");
  if (name === "general") throw new AppError("CONFLICT");
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
      ...(description !== undefined ? { description } : {}),
      ...(visibility ? { visibility } : {}),
      ...(members?.length ? { members } : {}),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("CONFLICT");
    throw error;
  }
  await Promise.all([
    announceChannelCreated(realtime, {
      workspaceId,
      conversationId: created.id,
      channel: channelInfoOf(created),
      ...(await channelAudience(db, created)),
    }),
    announceViewerEvent(realtime, {
      userIds: [userId],
      event: { type: REALTIME_EVENTS.channelJoined, workspaceId, conversationId: created.id },
    }),
  ]);
  return { id: created.id };
}
export async function createChannelWithMembers(
  ports: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  input: {
    name: string;
    visibility?: ChannelVisibility;
    userIds: string[];
    agentIds: string[];
  },
): Promise<{
  id: string;
  membersAddFailed: boolean;
}> {
  const { id } = await createUserChannel(ports, workspaceId, userId, input.name, {
    visibility: input.visibility,
  });
  if (input.userIds.length === 0 && input.agentIds.length === 0)
    return { id, membersAddFailed: false };
  try {
    await addChannelMembers(
      ports,
      workspaceId,
      { userId },
      id,
      {
        userIds: input.userIds,
        agentIds: input.agentIds,
      },
      { recordNotice: false },
    );
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
export async function changeChannelInfo(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  patch: {
    name?: string;
    description?: string;
  },
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
      ...(await channelAudience(db, { id: channel.id, visibility: updated.visibility })),
    });
    return { id: updated.id, name: updated.channelName!, description: updated.description };
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("CONFLICT");
    throw error;
  }
}
export async function isGeneralHidden(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const general = await generalForSettings(db, workspaceId, userId);
  return general.hiddenFromWorkspaceAt !== null;
}
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
          memberUserIds: undefined,
        },
  );
  return { id: general.id, hidden };
}
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
  const [agentMembers, tasks, objectKeys, audience] = await Promise.all([
    db.conversationMember.findMany({
      where: { conversationId: channel.id, agentId: { not: null }, ...ACTIVE_MEMBER_WHERE },
      select: { agentId: true },
    }),
    db.task.findMany({
      where: { conversationId: channel.id, ...LIVE_TASK_WHERE },
      select: { id: true },
    }),
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
  if ((channel.archivedAt !== null) === archived) return { id: channel.id, archived };
  const changed = await setChannelArchived(db, workspaceId, channel.id, archived);
  await announceChannelUpdated(realtime, {
    workspaceId,
    conversationId: channel.id,
    channel: channelInfoOf(changed),
    ...(await channelAudience(db, { id: channel.id, visibility: changed.visibility })),
  });
  return { id: channel.id, archived };
}
