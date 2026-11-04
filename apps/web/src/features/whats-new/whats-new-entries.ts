import type { ExperimentKey } from "#src/server/experiments/experiments.server";

/**
 * The "What's new" entries (task #493), as data the server and the sidebar share. Each ships in the
 * code of the release that introduces its feature; `releasedAt` is that release's time, to the
 * minute and unique, so entries have one order. Each entry's words and picture live in
 * `whats-new-content.tsx` under the same id.
 */
export type WhatsNewEntryData = {
  id: string;
  /** ISO time of the web release that ships the feature. An entry shows only from then on. */
  releasedAt: string;
  /** An experiment the feature needs: while it is off in the Workspace the entry is skipped, and
   * not counted as seen. */
  experiment?: ExperimentKey;
};

export const WHATS_NEW_ENTRIES = [
  { id: "task-labels", releasedAt: "2026-11-04T08:01:00Z" },
] as const satisfies readonly WhatsNewEntryData[];

export type WhatsNewId = (typeof WHATS_NEW_ENTRIES)[number]["id"];

export function isWhatsNewId(value: unknown): value is WhatsNewId {
  return WHATS_NEW_ENTRIES.some((entry) => entry.id === value);
}

/**
 * The entries a person has still to see, oldest first: released by now and after they joined,
 * not dismissed, and with any experiment they need on.
 */
export function pendingWhatsNew(
  entries: readonly WhatsNewEntryData[],
  viewer: {
    now: Date;
    joinedAt: Date;
    dismissed: readonly string[];
    experimentOn: (key: ExperimentKey) => boolean;
  },
): string[] {
  return entries
    .filter((entry) => {
      const released = Date.parse(entry.releasedAt);
      return (
        released <= viewer.now.getTime() &&
        released > viewer.joinedAt.getTime() &&
        !viewer.dismissed.includes(entry.id) &&
        (entry.experiment === undefined || viewer.experimentOn(entry.experiment))
      );
    })
    .sort((a, b) => Date.parse(a.releasedAt) - Date.parse(b.releasedAt))
    .map((entry) => entry.id);
}

/** How many released entries "What's new" shows when nothing is waiting. */
export const WHATS_NEW_RECENT = 5;

/**
 * The latest entries released by now, newest first, whether seen or not, and whenever the person
 * joined: what "What's new" shows when nothing is waiting (task #516).
 */
export function recentWhatsNew(
  entries: readonly WhatsNewEntryData[],
  viewer: { now: Date; experimentOn: (key: ExperimentKey) => boolean },
): string[] {
  return entries
    .filter(
      (entry) =>
        Date.parse(entry.releasedAt) <= viewer.now.getTime() &&
        (entry.experiment === undefined || viewer.experimentOn(entry.experiment)),
    )
    .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt))
    .slice(0, WHATS_NEW_RECENT)
    .map((entry) => entry.id);
}
