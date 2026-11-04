import type { TaskHistoryChange, TaskLabel } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import {
  requireWorkspaceMember,
  workspaceMemberRole,
} from "#src/server/workspaces/workspace-membership.server";
import {
  LABELS_PER_GROUP_MAX,
  LABEL_GROUP_SELECT,
  findLabelGroup,
  labelGroupNameKey,
  resolveLabelGroup,
  validateLabelGroupSelection,
  validateLabelOrGroupName,
  type LabelGroupRow,
} from "./label-groups.server";
import {
  assertLabelManager,
  assertLabelMember,
  labelCreatorUserId,
  type LabelActor,
} from "./label-actor.server";
import { mergeLabels } from "./label-merge.server";

/**
 * Workspace task labels: the rows, their names and colors, and the task↔label rows a Task write
 * adds or removes. Any Workspace member uses and creates a label; renaming, recoloring, merging,
 * archiving and deleting one is a Workspace-settings action. A label's `group/name` form names its
 * group; a group's `single` selection is enforced by the Task write, never by rewriting Tasks.
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
export const labelNameKey = labelGroupNameKey;

export type LabelRow = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  groupId: string | null;
  archivedAt: Date | null;
  group: LabelGroupRow | null;
};

export const LABEL_SELECT = {
  id: true,
  name: true,
  color: true,
  description: true,
  groupId: true,
  archivedAt: true,
  group: { select: LABEL_GROUP_SELECT },
} satisfies Prisma.LabelSelect;

/** A Task's view of a label: what its card draws. */
export const labelView = (row: { id: string; name: string; color: string }): TaskLabel => ({
  id: row.id,
  name: row.name,
  color: row.color,
});

export const validateLabelName = validateLabelOrGroupName;

export function validateLabelColor(color: string): LabelColor {
  if (!(LABEL_COLORS as readonly string[]).includes(color))
    throw new AppError("INVALID_INPUT", {
      errorId: "task-label-color",
      hint: `a label color is one of: ${LABEL_COLORS.join(", ")}`,
    });
  return color as LabelColor;
}

/** A label named as `group/label`, or just `label`. */
function splitLabelName(name: string): { group: string | null; label: string } {
  const slash = name.indexOf("/");
  if (slash < 0) return { group: null, label: name };
  return { group: name.slice(0, slash), label: name.slice(slash + 1) };
}

export type LabelCreateInput = {
  /** The label's description; an Agent must give one, so a new label is worth suggesting. */
  description?: string | null;
  /** The group's selection when this command makes the group. */
  selection?: string;
};

/**
 * The labels `names` name in this Workspace. A name no label has is created when the command gives
 * a description (the Agent rule); otherwise it is refused, naming the Workspace's own labels. An
 * archived label cannot be attached, and a `group/label` that names a different group than the
 * label's own is refused.
 */
export async function resolveTaskLabels(
  tx: Pick<Prisma.TransactionClient, "label" | "labelGroup">,
  workspaceId: string,
  names: readonly string[],
  create?: LabelCreateInput,
): Promise<LabelRow[]> {
  const asked = [
    ...new Map(
      names.map((name) => {
        const parts = splitLabelName(name);
        return [labelNameKey(parts.label), { ...parts, raw: name.trim() }];
      }),
    ).values(),
  ].filter((entry) => entry.label.trim());
  if (!asked.length) return [];
  const keys = asked.map((entry) => labelNameKey(entry.label));
  const rows = await tx.label.findMany({
    where: { workspaceId, nameKey: { in: keys } },
    select: { ...LABEL_SELECT, nameKey: true },
  });
  const known = new Map(rows.map((row) => [row.nameKey, row]));
  const resolved: LabelRow[] = [];
  for (const entry of asked) {
    const key = labelNameKey(entry.label);
    const existing = known.get(key);
    if (existing) {
      if (existing.archivedAt)
        throw new AppError("INVALID_INPUT", {
          errorId: "task-label-archived",
          hint: `the label "${existing.name}" is archived; it cannot be attached again`,
        });
      if (entry.group !== null && existing.group?.nameKey !== labelNameKey(entry.group))
        throw new AppError("INVALID_INPUT", {
          errorId: "task-label-group",
          hint: `"${existing.name}" belongs to ${existing.group ? `the group "${existing.group.name}"` : "no group"}, not "${entry.group}"`,
        });
      resolved.push(existing);
      continue;
    }
    if (create?.description === undefined || create.description === null)
      throw await unknownLabel(entry.raw, workspaceId, tx);
    const labelName = validateLabelOrGroupName(entry.label);
    const group =
      entry.group === null
        ? null
        : await resolveLabelGroup(
            tx,
            workspaceId,
            entry.group,
            validateLabelGroupSelection(create.selection ?? "single"),
          );
    if (group) await assertGroupRoom(tx, workspaceId, group.id);
    const created = await tx.label.create({
      data: {
        workspaceId,
        name: labelName,
        nameKey: key,
        color: "gray",
        description: create.description,
        groupId: group?.id,
      },
      select: LABEL_SELECT,
    });
    resolved.push(created);
  }
  return resolved;
}

async function unknownLabel(
  raw: string,
  workspaceId: string,
  tx: Pick<Prisma.TransactionClient, "label">,
): Promise<AppError> {
  const existing = await tx.label.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    take: 50,
    select: { name: true },
  });
  const near = nearestLabelNames(
    raw,
    existing.map((row) => row.name),
  );
  const suggestion = near.length
    ? `; did you mean ${near.join(", ")}?`
    : existing.length
      ? `; existing: ${existing
          .slice(0, 10)
          .map((row) => row.name)
          .join(", ")}`
      : "";
  return new AppError("INVALID_INPUT", {
    errorId: "task-label-unknown",
    hint: `no label named "${raw}" in this Workspace${suggestion}. Create it with \`coforge label create --description ...\` or pass --label-description`,
  });
}

/** Up to three existing names within a small edit distance of the one asked for. */
function nearestLabelNames(asked: string, names: readonly string[]): string[] {
  const key = labelNameKey(asked);
  return names
    .map((name) => ({ name, distance: editDistance(key, labelNameKey(name)) }))
    .filter(({ distance }) => distance > 0 && distance <= Math.max(2, Math.floor(key.length / 3)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ name }) => name);
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

async function assertGroupRoom(
  tx: Pick<Prisma.TransactionClient, "label">,
  workspaceId: string,
  groupId: string,
): Promise<void> {
  const count = await tx.label.count({ where: { workspaceId, groupId } });
  if (count >= LABELS_PER_GROUP_MAX)
    throw new AppError("INVALID_INPUT", {
      errorId: "label-group-full",
      hint: `a label group holds at most ${LABELS_PER_GROUP_MAX} labels`,
    });
}

/**
 * The `labels` predicate for a list filter: every named label must be on the Task (AND), and
 * `none` means no label at all. An unknown name is refused; a filter never creates one.
 */
export async function labelFilterWhere(
  db: Pick<Prisma.TransactionClient, "label" | "labelGroup">,
  workspaceId: string,
  names: readonly string[] | undefined,
): Promise<Prisma.TaskWhereInput | undefined> {
  if (!names?.length) return undefined;
  const none = names.some((name) => labelNameKey(name) === "none");
  if (none) {
    if (names.length > 1)
      throw new AppError("INVALID_INPUT", {
        errorId: "task-label-none",
        hint: "--label none cannot be combined with a label name",
      });
    return { labels: { none: { label: { archivedAt: null } } } };
  }
  // An archived label is on no Task any more, so naming it matches nothing (it is not an error:
  // a saved filter or a script that names it keeps working).
  const archived = await db.label.findFirst({
    where: {
      workspaceId,
      archivedAt: { not: null },
      nameKey: { in: names.map((name) => labelNameKey(splitLabelName(name).label)) },
    },
    select: { id: true },
  });
  if (archived) return { id: { in: [] } };
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

/** One label as the picker and `label list` show it. */
export type LabelSummary = LabelRow & {
  openCount: number;
  taskCount: number;
  lastUsedAt: string | null;
};

/** The Workspace's labels, their create/update/archive/merge/delete, and their counts. */
export class Labels {
  constructor(private readonly db: PrismaClient) {}

  /** Every label, with how many open and all Tasks carry it and when it was last attached. */
  async list(
    workspaceId: string,
    userId: string,
    filter: { group?: string; archived?: boolean } = {},
  ): Promise<LabelSummary[]> {
    await requireWorkspaceMember(this.db, workspaceId, userId);
    return this.summaries(workspaceId, filter);
  }

  /** The same read for an Agent: the Agent API has already authenticated it to the Workspace. */
  async listForWorkspace(
    workspaceId: string,
    filter: { group?: string; archived?: boolean } = {},
  ): Promise<LabelSummary[]> {
    return this.summaries(workspaceId, filter);
  }

  private async summaries(
    workspaceId: string,
    filter: { group?: string; archived?: boolean },
  ): Promise<LabelSummary[]> {
    const group = filter.group ? await findLabelGroup(this.db, workspaceId, filter.group) : null;
    if (filter.group && !group) throw new AppError("NOT_FOUND");
    const rows = await this.db.label.findMany({
      where: {
        workspaceId,
        ...(group && { groupId: group.id }),
        ...(filter.archived ? {} : { archivedAt: null }),
      },
      orderBy: [{ name: "asc" }],
      select: LABEL_SELECT,
    });
    const counts = await this.db.$queryRaw<
      { labelId: string; open: bigint; total: bigint; lastUsedAt: Date | null }[]
    >`
      SELECT tl."labelId" AS "labelId",
        COUNT(*) FILTER (WHERE t."status" NOT IN ('done', 'closed'))::bigint AS "open",
        COUNT(*)::bigint AS "total",
        MAX(tl."createdAt") AS "lastUsedAt"
      FROM "task_labels" tl
      JOIN "tasks" t ON t."id" = tl."taskId" AND t."deletedAt" IS NULL
      WHERE t."workspaceId" = ${workspaceId}::uuid
      GROUP BY tl."labelId"`;
    const byLabel = new Map(counts.map((row) => [row.labelId, row]));
    return rows.map((row) => {
      const count = byLabel.get(row.id);
      return {
        ...row,
        openCount: Number(count?.open ?? 0),
        taskCount: Number(count?.total ?? 0),
        lastUsedAt: count?.lastUsedAt?.toISOString() ?? null,
      };
    });
  }

  /** Any member or Agent creates a label; a name that already exists returns that label. */
  async create(
    workspaceId: string,
    actor: LabelActor,
    input: { name: string; color?: string; description?: string; group?: string },
  ): Promise<LabelRow> {
    await assertLabelMember(this.db, workspaceId, actor);
    const name = validateLabelOrGroupName(input.name);
    const color = validateLabelColor(input.color ?? "gray");
    const nameKey = labelNameKey(name);
    const existing = await this.db.label.findUnique({
      where: { workspaceId_nameKey: { workspaceId, nameKey } },
      select: LABEL_SELECT,
    });
    if (existing) return existing;
    const group = input.group ? await resolveLabelGroup(this.db, workspaceId, input.group) : null;
    if (group) await assertGroupRoom(this.db, workspaceId, group.id);
    try {
      return await this.db.label.create({
        data: {
          workspaceId,
          name,
          nameKey,
          color,
          description: input.description?.trim() || null,
          groupId: group?.id,
          createdByUserId: labelCreatorUserId(actor),
        },
        select: LABEL_SELECT,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.db.label.findUniqueOrThrow({
        where: { workspaceId_nameKey: { workspaceId, nameKey } },
        select: LABEL_SELECT,
      });
    }
  }

  /** An owner or admin (person or Agent) renames, recolors, describes, groups, archives or
   * unarchives a label. */
  async update(
    workspaceId: string,
    actor: LabelActor,
    id: string,
    input: {
      name?: string;
      color?: string;
      description?: string | null;
      group?: string | null;
      archived?: boolean;
    },
  ): Promise<LabelRow> {
    await assertLabelManager(this.db, workspaceId, actor);
    const label = await this.db.label.findFirst({
      where: { id, workspaceId },
      select: LABEL_SELECT,
    });
    if (!label) throw new AppError("NOT_FOUND");
    const name = input.name === undefined ? undefined : validateLabelOrGroupName(input.name);
    const color = input.color === undefined ? undefined : validateLabelColor(input.color);
    let groupId: string | null | undefined;
    if (input.group !== undefined) {
      const group =
        input.group === null ? null : await resolveLabelGroup(this.db, workspaceId, input.group);
      if (group && group.id !== label.groupId)
        await assertGroupRoom(this.db, workspaceId, group.id);
      groupId = group?.id ?? null;
    }
    if (
      name === undefined &&
      color === undefined &&
      input.description === undefined &&
      groupId === undefined &&
      input.archived === undefined
    )
      return label;
    try {
      return await this.db.label.update({
        where: { id: label.id },
        data: {
          ...(name !== undefined && { name, nameKey: labelNameKey(name) }),
          ...(color !== undefined && { color }),
          ...(input.description !== undefined && {
            description: input.description?.trim() || null,
          }),
          ...(groupId !== undefined && { groupId }),
          ...(input.archived !== undefined && {
            archivedAt: input.archived ? (label.archivedAt ?? new Date()) : null,
          }),
        },
        select: LABEL_SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError("CONFLICT", {
          errorId: "task-label-name-taken",
          hint: `a label named "${name}" already exists`,
        });
      throw error;
    }
  }

  /**
   * An owner or admin deletes an archived label for good; every task it was on loses it (the
   * join rows cascade). A live label must be archived first (task #508): permanent delete is the
   * second step, for the web page, an API caller and an Agent alike.
   */
  async delete(workspaceId: string, userId: string, id: string): Promise<void> {
    assertCanManageWorkspaceSettings(await workspaceMemberRole(this.db, workspaceId, userId));
    // Only an archived one goes, in the same statement, so a restore in between keeps it.
    const deleted = await this.db.label.deleteMany({
      where: { id, workspaceId, archivedAt: { not: null } },
    });
    if (deleted.count) return;
    const live = await this.db.label.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!live) throw new AppError("NOT_FOUND");
    throw new AppError("INVALID_INPUT", {
      errorId: "task-label-not-archived",
      hint: "archive the label before deleting it for good",
    });
  }

  /**
   * An owner or admin merges `from` into `into`: the Tasks carrying `from` carry `into` instead,
   * `from` disappears, and a Task that would then hold two labels of one single group keeps
   * `into` and loses the other (recorded as a system `labels_changed`). Returns what moved and
   * what was dropped, so the caller can report it.
   */
  async merge(
    workspaceId: string,
    userId: string,
    fromId: string,
    intoId: string,
  ): Promise<{ moved: number; dropped: number }> {
    return mergeLabels(this.db, workspaceId, userId, fromId, intoId);
  }
}
