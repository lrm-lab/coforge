/**
 * How a save over an older version keeps what others changed since its base (task #385). Files
 * merge by path in `Artifacts.push`; this module merges what is inside them and around them.
 */

/** An artifact's settings, which a version records and a save may change. */
export const ARTIFACT_SETTINGS = ["title", "description", "entryPath"] as const;
export type ArtifactSettingName = (typeof ARTIFACT_SETTINGS)[number];
export type ArtifactSettings = Record<ArtifactSettingName, string>;

/** One setting both sides changed, to different values. `base` is null when the save's base
 * is the artifact before its first version, whose settings no version recorded. */
export type ArtifactSettingConflict = {
  name: ArtifactSettingName;
  base: string | null;
  mine: string;
  theirs: string;
};

/** The answer to a save that cannot be merged: nothing was written. The client resolves each
 * conflict, then saves again with `currentVersion` as its base. */
export type ArtifactConflict = {
  status: "conflict";
  currentVersion: number;
  files: [];
  settings: ArtifactSettingConflict[];
};

/**
 * Merges settings item by item, as Raft does: an item only one side changed takes that side's
 * value, and one both changed to the same value is no conflict. With no recorded base (the save
 * began before the first version), any difference is a conflict: nothing is overwritten unseen.
 * `merged` names the items whose value came from the others.
 */
export function mergeSettings(
  base: ArtifactSettings | null,
  current: ArtifactSettings,
  mine: Partial<ArtifactSettings>,
): {
  result: ArtifactSettings;
  merged: ArtifactSettingName[];
  conflicts: ArtifactSettingConflict[];
} {
  const result = { ...current };
  const merged: ArtifactSettingName[] = [];
  const conflicts: ArtifactSettingConflict[] = [];
  for (const name of ARTIFACT_SETTINGS) {
    const theirs = current[name];
    const before = base?.[name] ?? null;
    const othersChanged = before !== null && theirs !== before;
    const value = mine[name];
    if (value === undefined || value === theirs || value === before) {
      if (othersChanged) merged.push(name);
      continue;
    }
    if (before !== null && !othersChanged) result[name] = value;
    else conflicts.push({ name, base: before, mine: value, theirs });
  }
  return { result, merged, conflicts };
}
