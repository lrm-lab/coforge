/**
 * What Settings → Labels (task #508) lists, as a pure function over the labels the server sends:
 * the search applied, the live labels by group (labels without a group first, then each group by
 * name), and the archived ones apart. Each list is ordered by name, case-insensitively.
 */

/** The longest label name the server takes (`LABEL_NAME_MAX` in labels.server.ts, which the
 * browser does not import). */
export const LABEL_NAME_MAX_LENGTH = 32;

export type SettingsLabel = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  archivedAt: Date | string | null;
  group: { id: string; name: string } | null;
  taskCount: number;
  openCount: number;
  lastUsedAt: string | null;
};

export type LabelSection<T extends SettingsLabel> = {
  /** The group's name; null for the labels that have none. */
  group: string | null;
  labels: T[];
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** Whether a label matches what was typed: its name or what it is for, ignoring case. */
export function labelMatches(label: SettingsLabel, search: string) {
  const wanted = search.trim().toLowerCase();
  if (!wanted) return true;
  return (
    label.name.toLowerCase().includes(wanted) ||
    (label.description ?? "").toLowerCase().includes(wanted)
  );
}

export function labelSections<T extends SettingsLabel>(
  labels: readonly T[],
  search: string,
): { live: LabelSection<T>[]; archived: T[] } {
  const matching = labels.filter((label) => labelMatches(label, search));
  const groups = new Map<string | null, T[]>();
  for (const label of matching.filter((each) => !each.archivedAt)) {
    const key = label.group?.name ?? null;
    groups.set(key, [...(groups.get(key) ?? []), label]);
  }
  const live = [...groups.entries()]
    .map(([group, list]) => ({ group, labels: list.sort(byName) }))
    .sort(
      (a, b) =>
        Number(a.group !== null) - Number(b.group !== null) ||
        (a.group ?? "").localeCompare(b.group ?? "", undefined, { sensitivity: "base" }),
    );
  const archived = matching.filter((each) => each.archivedAt).sort(byName);
  return { live, archived };
}

/** Whether `name` is another label's already, as the server judges it: case and outer spaces
 * aside. Shown before saving; the server's `task-label-name-taken` stays the authority. */
export function nameTaken(labels: readonly SettingsLabel[], name: string, ownId?: string) {
  const key = name.trim().toLowerCase();
  return labels.some((label) => label.id !== ownId && label.name.trim().toLowerCase() === key);
}
