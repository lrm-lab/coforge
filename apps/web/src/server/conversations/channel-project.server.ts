import { AppError } from "#src/lib/app-error";
import type { ChannelActor } from "./channel-actor.server";
import { findChannelById, type PublicChannelPorts } from "./channel-access.server";
import { resolveChannelAuthority } from "./channel-authority.server";
import { announceChannelUpdated, channelInfoOf } from "./conversation-realtime.server";
import { channelAudience } from "./conversation-signal-scope.server";

/** A channel's Project as the channel header and settings panel show it. */
export type ChannelProject = {
  id: string;
  name: string;
  slug: string;
  githubFullName: string | null;
  githubHtmlUrl: string | null;
};

const projectSelect = {
  id: true,
  name: true,
  slug: true,
  githubFullName: true,
  githubHtmlUrl: true,
} as const;

/**
 * Links a channel to a Project of its Workspace, moves it to another, or unlinks it
 * (`projectId` null), after the channel was created. Needs the `update` capability (Workspace
 * owner/admin or this channel's admin) like a rename; an archived channel is frozen. A Project of
 * another Workspace is refused as channel creation refuses it. Setting the value it already has
 * writes and announces nothing. Otherwise the channel's open pages hear `channel.updated.v1` and
 * refetch their header; the Project page lists its channels on load, with no push of its own.
 */
export async function changeChannelProject(
  { db, realtime }: PublicChannelPorts,
  workspaceId: string,
  actor: ChannelActor,
  channelId: string,
  projectId: string | null,
): Promise<{ id: string; project: ChannelProject | null }> {
  const channel = await findChannelById(db, workspaceId, actor, channelId);
  const authority = await resolveChannelAuthority(db, workspaceId, actor, channel);
  if (!authority.capabilities.update) throw new AppError("ACCESS_DENIED");
  if (channel.archivedAt) throw new AppError("CONFLICT");
  let project: ChannelProject | null = null;
  if (projectId) {
    project = await db.project.findFirst({
      where: { id: projectId, workspaceId },
      select: projectSelect,
    });
    if (!project) throw new AppError("INVALID_INPUT");
  }
  if (channel.projectId === projectId) return { id: channel.id, project };
  const updated = await db.conversation.update({
    where: { id: channel.id },
    data: { projectId },
    select: { channelName: true, description: true, archivedAt: true, visibility: true },
  });
  await announceChannelUpdated(realtime, {
    workspaceId,
    conversationId: channel.id,
    channel: channelInfoOf(updated),
    // As the write left it: a visibility change racing this one is announced by its own write.
    ...(await channelAudience(db, { id: channel.id, visibility: updated.visibility })),
  });
  return { id: channel.id, project };
}
