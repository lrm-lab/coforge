import type { TaskHistoryChange, TaskLabel } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import {
  requireWorkspaceMember,
  workspaceMemberRole,
} from "#src/server/workspaces/workspace-membership.server";

/**
 * Workspace task labels: the label rows, their names and colors, and the task↔label rows a Task
 * write adds or removes. Any Workspace member uses and creates a label; renaming or deleting one is
 * a Workspace-settings action (`manageWorkspaceSettings`, owner or admin).
 */

/** The Badge semantic color keys a label may use; never a hex value. */
export const LABEL_COLORS = [
  "gray",
  "brand",
  "error",
  "warning",
  "success",
  "slate",
  "sky",
  "blue",
  "indigo",
  "purple",
  "pink",
  "orange",
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
export const LABEL_NAME_MAX = 32;
/** One Task carries at most this many labels. */
export const LABELS_PER_TASK_MAX = 5;

/** What uniqueness and lookups use: the trimmed name, lower-cased. */
export const labelNameKey = (name: string) => name.trim().toLowerCase();

export type LabelRow = { id: string; name: string; color: string };

export const LABEL_SELECT = { id: true, name: true, color: true } satisfies Prisma.LabelSelect;

export const labelView = (row: LabelRow): TaskLabel => ({
  id: row.id,
  name: row.name,
  color: row.color,
});

export function validateLabelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > LABEL_NAME_MAX || /[\u0000-\u001f\u007f]/.test(trimmed))
    throw new AppError("INVALID_INPUT", {
      errorId: "task-label-name",
      hint: `a label name is 1 to ${LABEL_NAME_MAX} characters, with no control characters`,
    });
  return trimmed;
}

export function validateLabelColor(color: string): LabelColor {
  if (!(LABEL_COLORS as readonly string[]).includes(color))
    throw new AppError("INVALID_INPUT", {
      errorId: "task-label-color",
      hint: `a label color is one of: ${LABEL_COLORS.join(", ")}`,
    });
  return color as LabelColor;
}

/**
 * The labels `names` name in this Workspace, by case-insensitive name. An unknown name is
 * `INVALID_INPUT` naming it and up to ten of the Workspace's labels, so an Agent learns what it
 * could have used; a label is never created implicitly.
 */
export async function resolveTaskLabels(
  tx: Pick<Prisma.TransactionClient, "label">,
  workspaceId: string,
  names: readonly string[],
): Promise<LabelRow[]> {
  // The name as typed, by its key, so a refusal names it the way the command wrote it.
  const asked = [
    ...new Map(names.map((name) => [labelNameKey(name), name.trim()])).entries(),
  ].filter(([key]) => key);
  const keys = asked.map(([key]) => key);
  if (!keys.length) return [];
  const rows = await tx.label.findMany({
    where: { workspaceId, nameKey: { in: keys } },
    select: { ...LABEL_SELECT, nameKey: true },
  });
  const known = new Map(rows.map((row) => [row.nameKey, row]));
  const missing = asked.filter(([key]) => !known.has(key));
  if (missing.length) {
    const existing = await tx.label.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      take: 10,
      select: { name: true },
    });
    throw new AppError("INVALID_INPUT", {
      errorId: "task-label-unknown",
      hint: `no label named ${missing.map(([, name]) => `"${name}"`).join(", ")} in this Workspace${
        existing.length ? `; existing: ${existing.map((row) => row.name).join(", ")}` : ""
      }`,
    });
  }
  return keys.map((key) => {
    const { id, name, color } = known.get(key)!;
    return { id, name, color };
  });
}

/**
 * The `labels` predicate for a list filter: a Task must carry every named label (AND). An unknown
 * name is refused by `resolveTaskLabels`, as in a Task write.
 */
export async function labelFilterWhere(
  db: Pick<Prisma.TransactionClient, "label">,
  workspaceId: string,
  names: readonly string[] | undefined,
): Promise<Prisma.TaskWhereInput | undefined> {
  if (!names?.length) return undefined;
  const labels = await resolveTaskLabels(db, workspaceId, names);
  return { AND: labels.map((label) => ({ labels: { some: { labelId: label.id } } })) };
}

/** The history change a label edit records; null when nothing changed. */
export function labelsChange(
  added: readonly TaskLabel[],
  removed: readonly TaskLabel[],
): TaskHistoryChange | null {
  return added.length || removed.length
    ? { eventType: "labels_changed", payload: { added: [...added], removed: [...removed] } }
    : null;
}

/** The Workspace's labels, and their create/rename/delete. */
export class Labels {
  constructor(private readonly db: PrismaClient) {}

  async list(workspaceId: string, userId: string): Promise<TaskLabel[]> {
    await requireWorkspaceMember(this.db, workspaceId, userId);
    const rows = await this.db.label.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: LABEL_SELECT,
    });
    return rows.map(labelView);
  }

  /** Any member creates a label; a name that already exists (in any case) returns that label. */
  async create(
    workspaceId: string,
    userId: string,
    input: { name: string; color?: string },
  ): Promise<TaskLabel> {
    await requireWorkspaceMember(this.db, workspaceId, userId);
    const name = validateLabelName(input.name);
    const color = validateLabelColor(input.color ?? "gray");
    const nameKey = labelNameKey(name);
    const existing = await this.db.label.findUnique({
      where: { workspaceId_nameKey: { workspaceId, nameKey } },
      select: LABEL_SELECT,
    });
    if (existing) return labelView(existing);
    try {
      const created = await this.db.label.create({
        data: { workspaceId, name, nameKey, color, createdByUserId: userId },
        select: LABEL_SELECT,
      });
      return labelView(created);
    } catch (error) {
      // Two members creating the same name at once: the unique key picks one, and both see it.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.db.label.findUniqueOrThrow({
        where: { workspaceId_nameKey: { workspaceId, nameKey } },
        select: LABEL_SELECT,
      });
      return labelView(raced);
    }
  }

  /** An owner or admin renames a label and/or changes its color; a taken name is CONFLICT. */
  async update(
    workspaceId: string,
    userId: string,
    id: string,
    input: { name?: string; color?: string },
  ): Promise<TaskLabel> {
    assertCanManageWorkspaceSettings(await workspaceMemberRole(this.db, workspaceId, userId));
    const label = await this.db.label.findFirst({
      where: { id, workspaceId },
      select: { id: true, name: true, color: true },
    });
    if (!label) throw new AppError("NOT_FOUND");
    const name = input.name === undefined ? undefined : validateLabelName(input.name);
    const color = input.color === undefined ? undefined : validateLabelColor(input.color);
    if (name === undefined && color === undefined) return labelView(label);
    try {
      const updated = await this.db.label.update({
        where: { id: label.id },
        data: {
          ...(name !== undefined && { name, nameKey: labelNameKey(name) }),
          ...(color !== undefined && { color }),
        },
        select: LABEL_SELECT,
      });
      return labelView(updated);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError("CONFLICT", {
          errorId: "task-label-name-taken",
          hint: `a label named "${name}" already exists`,
        });
      throw error;
    }
  }

  /** An owner or admin deletes a label; every task it was on loses it (the join rows cascade). */
  async delete(workspaceId: string, userId: string, id: string): Promise<void> {
    assertCanManageWorkspaceSettings(await workspaceMemberRole(this.db, workspaceId, userId));
    const deleted = await this.db.label.deleteMany({ where: { id, workspaceId } });
    if (!deleted.count) throw new AppError("NOT_FOUND");
  }
}
