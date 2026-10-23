import type { Prisma } from "#src/generated/prisma/client";
import type { WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import { recordAppNotifications } from "./app-notifications.server";
import { channelMemberEvents } from "./channel-events.server";

/**
 * What apps are told about a Workspace's people and settings. Each function runs inside the
 * transaction of the domain write it describes (see `AppNotifications.record`), so the event
 * exists only if that write commits, and carries ids and the changed fields, never a record.
 */

/** A member left or was removed, and with them every channel they were an active member of. */
export function recordMemberRemoved(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  member: { userId: string; leftChannelIds: readonly string[] },
) {
  return recordAppNotifications(tx, { id: workspaceId }, [
    { type: "workspace.member_removed", data: { user_id: member.userId } },
    ...channelMemberEvents("channel.member_removed", member.leftChannelIds, {
      userId: member.userId,
    }),
  ]);
}

export function recordMemberRoleChanged(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  change: { userId: string; previousRole: WorkspaceMemberRole; role: WorkspaceMemberRole },
) {
  if (change.previousRole === change.role) return Promise.resolve();
  return recordAppNotifications(tx, { id: workspaceId }, [
    {
      type: "workspace.member_role_changed",
      data: { user_id: change.userId, previous_role: change.previousRole, role: change.role },
    },
  ]);
}

/** `workspace` carries the slug the write just stored, which the flag is evaluated with. */
export function recordWorkspaceConfigUpdated(
  tx: Prisma.TransactionClient,
  workspace: { id: string; slug: string },
  change: { name?: string; slug?: string; icon?: true },
) {
  const fields = (["name", "slug", "icon"] as const).filter((field) => change[field] !== undefined);
  if (fields.length === 0) return Promise.resolve();
  return recordAppNotifications(tx, workspace, [
    {
      type: "workspace.config_updated",
      data: {
        fields,
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.slug !== undefined ? { slug: change.slug } : {}),
      },
    },
  ]);
}
