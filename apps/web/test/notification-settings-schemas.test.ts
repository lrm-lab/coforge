import { expect, test } from "bun:test";
import {
  activityReportSchema,
  notificationSettingsChangeSchema,
} from "#src/features/notifications/notification-settings.schemas";

/** What a notification settings save and an activity report may carry (task #467). */

const accepts = (input: unknown) => notificationSettingsChangeSchema.safeParse(input).success;

test("a save names its version and only known fields, each within its range", () => {
  expect(accepts({ expectedVersion: 0, changes: {} })).toBe(true);
  expect(
    accepts({
      expectedVersion: 3,
      changes: {
        pausedUntil: "2026-11-03T11:00:00.000Z",
        quietHours: { enabled: true, startMinute: 0, endMinute: 1439 },
        previewMode: "hidden",
        sound: false,
        mobileDelay: "idle_10m",
      },
    }),
  ).toBe(true);
  expect(accepts({ expectedVersion: 0, changes: { pausedUntil: null } })).toBe(true);

  for (const bad of [
    { changes: {} },
    { expectedVersion: -1, changes: {} },
    { expectedVersion: 0, changes: { volume: 3 } },
    { expectedVersion: 0, changes: {}, extra: true },
    { expectedVersion: 0, changes: { previewMode: "some" } },
    { expectedVersion: 0, changes: { mobileDelay: "idle_3m" } },
    { expectedVersion: 0, changes: { pausedUntil: "tomorrow" } },
    {
      expectedVersion: 0,
      changes: { quietHours: { enabled: true, startMinute: 0, endMinute: 1440 } },
    },
    {
      expectedVersion: 0,
      changes: { quietHours: { enabled: true, startMinute: 600, endMinute: 600 } },
    },
    { expectedVersion: 0, changes: { quietHours: { enabled: true, startMinute: 600 } } },
  ])
    expect(accepts(bad)).toBe(false);
});

test("an activity report is the last input time, nothing else", () => {
  expect(activityReportSchema.safeParse({ lastInputAt: "2026-11-03T10:00:00.000Z" }).success).toBe(
    true,
  );
  expect(activityReportSchema.safeParse({ lastInputAt: 1730000000000 }).success).toBe(false);
  expect(
    activityReportSchema.safeParse({
      lastInputAt: "2026-11-03T10:00:00.000Z",
      deviceKind: "mobile",
    }).success,
  ).toBe(false);
});
