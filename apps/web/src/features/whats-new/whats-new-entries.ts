import type { ExperimentKey } from "#src/server/experiments/experiments.server";

export type WhatsNewEntryData = {
  id: string;
  releasedAt: string;
  experiment?: ExperimentKey;
  announce?: true;
  includeNewcomers?: true;
};

export const WHATS_NEW_ENTRIES = [
  { id: "task-labels", releasedAt: "2026-11-04T08:01:00Z" },
  {
    id: "artifacts",
    releasedAt: "2026-11-20T07:00:00Z",
    announce: true,
    includeNewcomers: true,
  },
] as const satisfies readonly WhatsNewEntryData[];

export type WhatsNewId = (typeof WHATS_NEW_ENTRIES)[number]["id"];

export function isWhatsNewId(value: unknown): value is WhatsNewId {
  return WHATS_NEW_ENTRIES.some((entry) => entry.id === value);
}

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
        (entry.includeNewcomers === true || released > viewer.joinedAt.getTime()) &&
        !viewer.dismissed.includes(entry.id) &&
        (entry.experiment === undefined || viewer.experimentOn(entry.experiment))
      );
    })
    .sort((a, b) => Date.parse(a.releasedAt) - Date.parse(b.releasedAt))
    .map((entry) => entry.id);
}

export function announcedWhatsNew<Id extends string>(
  entries: readonly WhatsNewEntryData[],
  pending: readonly Id[],
  announced: readonly string[],
): Id[] {
  return pending.filter(
    (id) =>
      !announced.includes(id) &&
      entries.some((entry) => entry.id === id && entry.announce === true),
  );
}
