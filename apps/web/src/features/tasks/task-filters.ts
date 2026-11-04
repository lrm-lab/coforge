import { TASK_STATUSES, type TaskMember, type TaskStatus } from "@lrm/coforge-sdk/internal";

/**
 * A Task board's owner and Project filters, applied to the rows the board shows. Each takes
 * several picks; a Task matches when its owner is one of the picked owners and its Project one of
 * the picked Projects, and an empty pick keeps every Task. Owners are picked by User or Agent id,
 * Projects by id; the two constants below stand for "nobody" and "no Project".
 */
export const NO_OWNER = "none";
export const NO_PROJECT = "none";
/** The label pick for "no label at all"; it stands alone (task #455). */
export const NO_LABEL = "none";

export type FilterableTask = {
  owner: TaskMember | null;
  /**
   * The Project the Task's conversation belongs to; absent on a one-conversation board. `iconUrl`
   * is its uploaded icon, which a Task row's pill shows.
   */
  project?: { id: string; name: string; iconUrl?: string | null } | null;
  /** The viewer's membership in the Task's conversation: an owner with it is the viewer. */
  currentMemberId?: string | null;
  /** How many Tasks this entry stands for: a counted group of finished Tasks; one when absent. */
  count?: number;
  /** Its labels; absent on a counted group, which the server already read for the label pick. */
  labels?: readonly { id: string; name: string; color: string }[];
};

export type TaskFilter = {
  owners: readonly string[];
  projects: readonly string[];
  /** Label ids a Task must all carry, or `none` for the Tasks with no label. */
  labels: readonly string[];
};

/** Whether a Task passes the label pick. A counted group (no labels of its own) was read for it. */
function labelsMatch(task: FilterableTask, picked: readonly string[]) {
  if (picked.length === 0 || task.labels === undefined) return true;
  if (picked.includes(NO_LABEL)) return task.labels.length === 0;
  return picked.every((id) => task.labels!.some((label) => label.id === id));
}

function ownerKey(task: FilterableTask) {
  return task.owner?.id ?? NO_OWNER;
}

function projectKey(task: FilterableTask) {
  return task.project?.id ?? NO_PROJECT;
}

export function taskMatches(task: FilterableTask, filter: TaskFilter) {
  return (
    (filter.owners.length === 0 || filter.owners.includes(ownerKey(task))) &&
    (filter.projects.length === 0 || filter.projects.includes(projectKey(task))) &&
    labelsMatch(task, filter.labels)
  );
}

export type OwnerOption = {
  id: string;
  kind: "me" | "none" | "user" | "agent";
  name: string;
  /** An Agent's handle; people are picked by name. */
  handle?: string;
  avatarUrl?: string | null;
  count: number;
};

/** The owners to pick from, with how many Tasks each has: the viewer and Unassigned first, then
 * people and Agents by name. */
export function ownerOptions(tasks: readonly FilterableTask[]): OwnerOption[] {
  const byId = new Map<string, OwnerOption>();
  for (const task of tasks) {
    const id = ownerKey(task);
    const owner = task.owner;
    // The viewer's membership is per conversation, and absent where they are not a member: any
    // one of their Tasks in a conversation they are in makes them "me".
    const isViewer = owner !== null && owner.memberId === task.currentMemberId;
    const known = byId.get(id);
    if (known) {
      known.count += task.count ?? 1;
      if (isViewer) known.kind = "me";
      continue;
    }
    const kind = !owner ? "none" : isViewer ? "me" : owner.kind;
    byId.set(id, {
      id,
      kind,
      name: owner?.name ?? "",
      ...(owner?.kind === "agent" && { handle: owner.handle }),
      avatarUrl: owner?.avatarUrl,
      count: task.count ?? 1,
    });
  }
  const rank = { me: 0, none: 1, user: 2, agent: 3 } as const;
  return [...byId.values()].sort(
    (left, right) => rank[left.kind] - rank[right.kind] || left.name.localeCompare(right.name),
  );
}

export type ProjectOption = { id: string; name: string; iconUrl?: string | null; count: number };

/** The Projects to pick from by name, then "No project", with how many Tasks each has. */
export function projectOptions(tasks: readonly FilterableTask[]): ProjectOption[] {
  const byId = new Map<string, ProjectOption>();
  for (const task of tasks) {
    const id = projectKey(task);
    const known = byId.get(id);
    if (known) known.count += task.count ?? 1;
    else
      byId.set(id, {
        id,
        name: task.project?.name ?? "",
        iconUrl: task.project?.iconUrl,
        count: task.count ?? 1,
      });
  }
  return [...byId.values()].sort((left, right) =>
    left.id === NO_PROJECT ? 1 : right.id === NO_PROJECT ? -1 : left.name.localeCompare(right.name),
  );
}

/** A pick as it travels in the address: comma-separated, so it stays readable; none is absent. */
export function filterParam(values: readonly string[]): string | undefined {
  return values.length > 0 ? values.join(",") : undefined;
}

export function parseFilterParam(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

/**
 * The statuses a board shows (task #506): several may be picked, read from one comma-separated
 * `status` in the address, so a link with a single status still reads. Unknown and repeated values
 * drop out, and the picks keep the board's column order; none picked shows every status.
 */
export function parseStatusParam(value: string | undefined): TaskStatus[] {
  const picked = new Set(parseFilterParam(value));
  return TASK_STATUSES.filter((status) => picked.has(status));
}

/** Whether a Task's status passes the pick; an empty pick keeps every Task. */
export function statusMatches(status: TaskStatus, picked: readonly TaskStatus[]) {
  return picked.length === 0 || picked.includes(status);
}

export type LabelOption = { id: string; name: string; color: string; count: number };

/** The labels to pick from by name, after "No label", with how many Tasks carry each. */
export function labelOptions(tasks: readonly FilterableTask[]): LabelOption[] {
  const byId = new Map<string, LabelOption>();
  let unlabelled = 0;
  for (const task of tasks) {
    if (!task.labels) continue;
    if (task.labels.length === 0) unlabelled += task.count ?? 1;
    for (const label of task.labels) {
      const known = byId.get(label.id);
      if (known) known.count += task.count ?? 1;
      else byId.set(label.id, { ...label, count: task.count ?? 1 });
    }
  }
  const named = [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  return [{ id: NO_LABEL, name: "", color: "gray", count: unlabelled }, ...named];
}
