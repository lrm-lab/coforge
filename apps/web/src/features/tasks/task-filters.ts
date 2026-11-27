import { TASK_WRITE_STATUSES, type TaskMember, type TaskStatus } from "@lrm/coforge-sdk/internal";

export const NO_OWNER = "none";
export const NO_PROJECT = "none";
export const NO_LABEL = "none";

export type FilterableTask = {
  owner: TaskMember | null;
  project?: { id: string; name: string; iconUrl?: string | null } | null;
  currentMemberId?: string | null;
  count?: number;
  labels?: readonly { id: string; name: string; color: string }[];
  conversationId?: string;
  source?: { label: string };
};

export type TaskFilter = {
  owners: readonly string[];
  projects: readonly string[];
  labels: readonly string[];
};

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
  handle?: string;
  avatarUrl?: string | null;
  count: number;
};

export function ownerOptions(
  tasks: readonly FilterableTask[],
  fallbackCurrentMemberId?: string | null,
): OwnerOption[] {
  const byId = new Map<string, OwnerOption>();
  for (const task of tasks) {
    const id = ownerKey(task);
    const owner = task.owner;
    const memberId = task.currentMemberId ?? fallbackCurrentMemberId ?? null;
    const isViewer = owner !== null && memberId !== null && owner.memberId === memberId;
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

export function filterParam(values: readonly string[]): string | undefined {
  return values.length > 0 ? values.join(",") : undefined;
}

export function parseFilterParam(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

export function parseStatusParam(value: string | undefined): TaskStatus[] {
  const picked = new Set(parseFilterParam(value));
  return TASK_WRITE_STATUSES.filter((status) => picked.has(status));
}

export function statusMatches(status: TaskStatus, picked: readonly TaskStatus[]) {
  return picked.length === 0 || picked.includes(status);
}

export type LabelOption = { id: string; name: string; color: string; count: number };

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

export function availableTaskStatuses(_tasks?: readonly { status: TaskStatus }[]) {
  return TASK_WRITE_STATUSES;
}
