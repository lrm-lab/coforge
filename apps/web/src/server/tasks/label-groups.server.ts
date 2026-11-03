import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import {
  requireWorkspaceMember,
  workspaceMemberRole,
} from "#src/server/workspaces/workspace-membership.server";

/**
 * Label groups: one level of names a label belongs to, and whether a Task may carry one label of
 * the group (`single`, the default) or several. Creating a group is a member action; renaming,
 * changing its selection and deleting it are Workspace-settings actions.
 */

export const LABEL_GROUP_SELECTIONS = ["single", "multiple"] as const;
export type LabelGroupSelection = (typeof LABEL_GROUP_SELECTIONS)[number];
export const LABEL_GROUP_NAME_MAX = 32;
/** Labels one group may hold; a group is a filter, not a second Workspace. */
export const LABELS_PER_GROUP_MAX = 250;

/**
 * Names a label or group may not take: they are Task fields or commands, so a label of that name
 * would read as one. `none` is `task list --label none`'s "no labels".
 */
export const RESERVED_LABEL_NAMES: ReadonlySet<string> = new Set([
  "assignee",
  "blocked",
  "blockedby",
  "cycle",
  "description",
  "due",
  "dueat",
  "estimate",
  "group",
  "label",
  "labels",
  "none",
  "owner",
  "parent",
  "priority",
  "project",
  "status",
  "waiting",
  "waitingfor",
]);

export const LABEL_GROUP_SELECT = {
  id: true,
  name: true,
  nameKey: true,
  selection: true,
} satisfies Prisma.LabelGroupSelect;

export type LabelGroupRow = { id: string; name: string; nameKey: string; selection: string };

/** A label or group name as uniqueness and lookups use it. */
export const labelGroupNameKey = (name: string) => name.trim().toLowerCase();

/**
 * A label or group name: 1 to 32 characters, no control characters, no `/` (which separates a
 * group from a label), not starting with `-` (the CLI's "take it off"), and not a reserved name.
 */
export function validateLabelOrGroupName(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.length > LABEL_GROUP_NAME_MAX ||
    /[\u0000-\u001f\u007f/]/.test(trimmed) ||
    trimmed.startsWith("-")
  )
    throw new AppError("INVALID_INPUT", {
      errorId: "task-label-name",
      hint: `a label name is 1 to ${LABEL_GROUP_NAME_MAX} characters, with no control characters or "/", and does not start with "-" (the CLI reads --label -name as taking it off)`,
    });
  if (RESERVED_LABEL_NAMES.has(labelGroupNameKey(trimmed)))
    throw new AppError("INVALID_INPUT", {
      errorId: "task-label-reserved",
      hint: `"${trimmed}" is a Task field or command, so it cannot be a label name`,
    });
  return trimmed;
}

export function validateLabelGroupSelection(selection: string): LabelGroupSelection {
  if (!(LABEL_GROUP_SELECTIONS as readonly string[]).includes(selection))
    throw new AppError("INVALID_INPUT", {
      errorId: "label-group-selection",
      hint: `a group is one of: ${LABEL_GROUP_SELECTIONS.join(", ")}`,
    });
  return selection as LabelGroupSelection;
}

/** The group `name` in this Workspace, or null. */
export async function findLabelGroup(
  tx: Pick<Prisma.TransactionClient, "labelGroup">,
  workspaceId: string,
  name: string,
): Promise<LabelGroupRow | null> {
  return tx.labelGroup.findUnique({
    where: { workspaceId_nameKey: { workspaceId, nameKey: labelGroupNameKey(name) } },
    select: LABEL_GROUP_SELECT,
  });
}

/**
 * The group `name` names, created when it does not exist yet (a member may create one by naming
 * it). Its selection is `single` unless the command asked for `multiple`.
 */
export async function resolveLabelGroup(
  tx: Pick<Prisma.TransactionClient, "labelGroup">,
  workspaceId: string,
  name: string,
  selection: LabelGroupSelection = "single",
): Promise<LabelGroupRow> {
  const existing = await findLabelGroup(tx, workspaceId, name);
  if (existing) return existing;
  const trimmed = validateLabelOrGroupName(name);
  return tx.labelGroup.create({
    data: {
      workspaceId,
      name: trimmed,
      nameKey: labelGroupNameKey(trimmed),
      selection,
    },
    select: LABEL_GROUP_SELECT,
  });
}

/** The Workspace's label groups, and their create/rename/selection/delete. */
export class LabelGroups {
  constructor(private readonly db: PrismaClient) {}

  async list(workspaceId: string, userId: string): Promise<LabelGroupRow[]> {
    await requireWorkspaceMember(this.db, workspaceId, userId);
    return this.db.labelGroup.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: LABEL_GROUP_SELECT,
    });
  }

  /** Any member creates a group; a name that already exists returns that group. */
  async create(
    workspaceId: string,
    userId: string,
    input: { name: string; selection?: string },
  ): Promise<LabelGroupRow> {
    await requireWorkspaceMember(this.db, workspaceId, userId);
    const name = validateLabelOrGroupName(input.name);
    const selection = validateLabelGroupSelection(input.selection ?? "single");
    const existing = await findLabelGroup(this.db, workspaceId, name);
    if (existing) return existing;
    try {
      return await this.db.labelGroup.create({
        data: { workspaceId, name, nameKey: labelGroupNameKey(name), selection },
        select: LABEL_GROUP_SELECT,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return (await findLabelGroup(this.db, workspaceId, name))!;
    }
  }

  /**
   * An owner or admin renames a group and/or changes its selection. A switch to `single` never
   * rewrites existing Tasks; it reports how many Tasks currently carry more than one of its labels,
   * so the caller can say so.
   */
  async update(
    workspaceId: string,
    userId: string,
    id: string,
    input: { name?: string; selection?: string },
  ): Promise<{ group: LabelGroupRow; nonConforming: number }> {
    assertCanManageWorkspaceSettings(await workspaceMemberRole(this.db, workspaceId, userId));
    const group = await this.db.labelGroup.findFirst({
      where: { id, workspaceId },
      select: LABEL_GROUP_SELECT,
    });
    if (!group) throw new AppError("NOT_FOUND");
    const name = input.name === undefined ? undefined : validateLabelOrGroupName(input.name);
    const selection =
      input.selection === undefined ? undefined : validateLabelGroupSelection(input.selection);
    const nonConforming =
      selection === "single" && group.selection !== "single"
        ? await this.nonConformingTasks(workspaceId, id)
        : 0;
    if (name === undefined && selection === undefined) return { group, nonConforming };
    try {
      const updated = await this.db.labelGroup.update({
        where: { id: group.id },
        data: {
          ...(name !== undefined && { name, nameKey: labelGroupNameKey(name) }),
          ...(selection !== undefined && { selection }),
        },
        select: LABEL_GROUP_SELECT,
      });
      return { group: updated, nonConforming };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError("CONFLICT", {
          errorId: "label-group-name-taken",
          hint: `a label group named "${name}" already exists`,
        });
      throw error;
    }
  }

  /** An owner or admin deletes a group; its labels stay, ungrouped (the foreign key sets null). */
  async delete(workspaceId: string, userId: string, id: string): Promise<void> {
    assertCanManageWorkspaceSettings(await workspaceMemberRole(this.db, workspaceId, userId));
    const deleted = await this.db.labelGroup.deleteMany({ where: { id, workspaceId } });
    if (!deleted.count) throw new AppError("NOT_FOUND");
  }

  /** How many Tasks carry more than one label of this group. */
  private async nonConformingTasks(workspaceId: string, groupId: string): Promise<number> {
    const rows = await this.db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS "count" FROM (
        SELECT tl."taskId"
        FROM "task_labels" tl
        JOIN "labels" l ON l."id" = tl."labelId" AND l."workspaceId" = ${workspaceId}::uuid
        WHERE l."groupId" = ${groupId}::uuid
        GROUP BY tl."taskId"
        HAVING COUNT(*) > 1
      ) many`;
    return Number(rows[0]?.count ?? 0);
  }
}
