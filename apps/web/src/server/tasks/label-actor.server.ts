import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { resolveActorServerRole } from "#src/server/conversations/channel-authority.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import {
  requireWorkspaceMember,
  workspaceMemberRole,
} from "#src/server/workspaces/workspace-membership.server";

/**
 * Who writes a label: a person by user id (the web page), or an Agent (the Agent API, task #508).
 * An Agent gets what a person in its role gets: any active Agent creates a label, and only one
 * whose server role is owner or admin renames, recolors, archives or restores one.
 */
export type LabelActor = string | { agentId: string };

type LabelActorDb = Pick<PrismaClient, "workspaceMembership" | "agent">;

/** Any member, or any active Agent of the Workspace. */
export async function assertLabelMember(
  db: LabelActorDb,
  workspaceId: string,
  actor: LabelActor,
): Promise<void> {
  if (typeof actor === "string") {
    await requireWorkspaceMember(db, workspaceId, actor);
    return;
  }
  if ((await resolveActorServerRole(db, workspaceId, actor)) === undefined)
    throw new AppError("ACCESS_DENIED");
}

/** A Workspace owner or admin, person or Agent. */
export async function assertLabelManager(
  db: LabelActorDb,
  workspaceId: string,
  actor: LabelActor,
): Promise<void> {
  assertCanManageWorkspaceSettings(
    typeof actor === "string"
      ? await workspaceMemberRole(db, workspaceId, actor)
      : await resolveActorServerRole(db, workspaceId, actor),
  );
}

/** The label's `createdByUserId`: a person's id; an Agent's label records none. */
export const labelCreatorUserId = (actor: LabelActor): string | null =>
  typeof actor === "string" ? actor : null;
