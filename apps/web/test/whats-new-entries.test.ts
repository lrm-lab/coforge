import { expect, test } from "bun:test";
import { WHATS_NEW_CONTENT } from "#src/features/whats-new/whats-new-content";
import {
  WHATS_NEW_ENTRIES,
  pendingWhatsNew,
  recentWhatsNew,
  type WhatsNewEntryData,
} from "#src/features/whats-new/whats-new-entries";

test("every entry has its own release minute, an id of its own and words and a picture", () => {
  const times = WHATS_NEW_ENTRIES.map((entry) => entry.releasedAt);
  for (const time of times) {
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(Number.isNaN(Date.parse(time))).toBe(false);
  }
  // Two entries at one time would have no order between them.
  expect(new Set(times).size).toBe(times.length);
  const ids = WHATS_NEW_ENTRIES.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(Object.keys(WHATS_NEW_CONTENT).sort()).toEqual([...ids].sort());
});

const entries: WhatsNewEntryData[] = [
  { id: "later", releasedAt: "2026-11-10T07:00:00Z" },
  {
    id: "needs-docs",
    releasedAt: "2026-11-04T07:00:00Z",
    experiment: "artifacts",
  },
  { id: "labels", releasedAt: "2026-11-04T07:01:00Z" },
];
const viewer = {
  now: new Date("2026-11-05T00:00:00Z"),
  joinedAt: new Date("2026-10-01T00:00:00Z"),
  dismissed: [] as string[],
  experimentOn: () => true,
};

test("released entries show oldest first; one not yet released waits", () => {
  expect(pendingWhatsNew(entries, viewer)).toEqual(["needs-docs", "labels"]);
});

test("someone who joined after an entry's release never sees it", () => {
  expect(
    pendingWhatsNew(entries, {
      ...viewer,
      joinedAt: new Date("2026-11-04T07:00:30Z"),
    }),
  ).toEqual(["labels"]);
});

test("a dismissed entry is gone and the next shows", () => {
  expect(pendingWhatsNew(entries, { ...viewer, dismissed: ["needs-docs"] })).toEqual(["labels"]);
});

test("an entry whose experiment is off is skipped, and shows once it is on", () => {
  const off = { ...viewer, experimentOn: () => false, dismissed: ["labels"] };
  expect(pendingWhatsNew(entries, off)).toEqual([]);
  // Dismissing a later entry meanwhile does not count the skipped one as seen.
  expect(pendingWhatsNew(entries, { ...off, experimentOn: () => true })).toEqual(["needs-docs"]);
});

test("with nothing waiting, the latest released entries show newest first, seen or not (task #516)", () => {
  const recent = { now: viewer.now, experimentOn: () => true };
  // "later" is not released yet; seen entries and the join time do not matter here.
  expect(recentWhatsNew(entries, recent)).toEqual(["labels", "needs-docs"]);
  expect(recentWhatsNew(entries, { ...recent, experimentOn: () => false })).toEqual(["labels"]);
  const many: WhatsNewEntryData[] = Array.from({ length: 8 }, (_, at) => ({
    id: `entry-${at}`,
    releasedAt: `2026-11-0${at + 1}T07:00:00Z`,
  }));
  expect(
    recentWhatsNew(many, { now: new Date("2026-12-01T00:00:00Z"), experimentOn: () => true }),
  ).toEqual(["entry-7", "entry-6", "entry-5", "entry-4", "entry-3"]);
});
