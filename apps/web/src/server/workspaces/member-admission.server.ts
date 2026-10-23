import type { Prisma } from "#src/generated/prisma/client";
import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import { AppNotifications } from "#src/server/app-notifications/app-notifications.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import type { WorkspaceMemberRole } from "./member-role.server";

/**
 * Someone joins the Workspace, by a join link: their membership, their
 * place in `#general`, and their direct conversations from an earlier stay active again with read
 * positions kept (the other channels they were in stay left until they join them). Runs inside the
 * caller's transaction; it reports the channels whose member lists changed so the caller can
 * announce them once the transaction commits. It also records `workspace.member_added` for the
 * apps installed in the Workspace, which exists only if that transaction commits.
 */
export async function admitWorkspaceMember(
  tx: Prisma.TransactionClient,
  input: {
    workspace: { id: string; slug: string };
    userId: string;
    role: WorkspaceMemberRole;
  },
): Promise<{ joinedChannelIds: string[] }> {
  await tx.workspaceMembership.create({
    data: { workspaceId: input.workspace.id, userId: input.userId, role: input.role },
  });
  const general = await enrollGeneralChannel(tx, input.workspace.id);
  await tx.conversationMember.updateMany({
    where: {
      workspaceId: input.workspace.id,
      userId: input.userId,
      leftAt: { not: null },
      conversation: { directKey: { not: null } },
    },
    data: { leftAt: null },
  });
  await AppNotifications.record(
    tx,
    input.workspace,
    newAppNotificationEvent({
      type: "workspace.member_added",
      workspaceId: input.workspace.id,
      data: { user_id: input.userId, role: input.role },
    }),
  );
  return { joinedChannelIds: [general.id] };
}
