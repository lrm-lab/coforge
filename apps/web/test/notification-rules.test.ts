import { describe, expect, test } from "bun:test";
import {
  ACTIVE_INPUT_WINDOW_MS,
  DEFAULT_NOTIFICATION_SETTINGS,
  PRESENCE_ONLINE_TTL_MS,
  mobileDeferredUntil,
  previewNotification,
  suppression,
  type NotificationSettings,
} from "#src/server/notifications/notification-rules.server";

/**
 * The account notification settings' rules (task #467, as Raft 1.0.60's
 * `packages/shared/src/notifications.ts`): pause and quiet hours suppress a notification, a phone's
 * waits while the computer is in use, and the preview and sound shape what is sent.
 */

const settings = (changes: Partial<NotificationSettings> = {}): NotificationSettings => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...changes,
});
const at = (iso: string) => new Date(iso);
const MINUTE = 60_000;

test("the defaults are Raft's", () => {
  expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
    pausedUntil: null,
    quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 8 * 60 },
    previewMode: "full",
    sound: true,
    mobileDelay: "inactive",
    version: 0,
  });
  expect(ACTIVE_INPUT_WINDOW_MS).toBe(3 * MINUTE);
  expect(PRESENCE_ONLINE_TTL_MS).toBe(150_000);
});

describe("suppression", () => {
  test("a pause holds until its instant", () => {
    const paused = settings({ pausedUntil: at("2026-11-03T10:00:00Z") });
    expect(suppression(paused, "UTC", at("2026-11-03T09:59:59Z"))).toBe("paused");
    expect(suppression(paused, "UTC", at("2026-11-03T10:00:00Z"))).toBeNull();
  });

  test("quiet hours cross midnight in the person's own time zone", () => {
    const quiet = settings({
      quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 },
    });
    // 22:30 and 07:59 in Shanghai are inside; 08:00 and 21:59 are not.
    expect(suppression(quiet, "Asia/Shanghai", at("2026-11-03T14:30:00Z"))).toBe("quiet_hours");
    expect(suppression(quiet, "Asia/Shanghai", at("2026-11-03T23:59:00Z"))).toBe("quiet_hours");
    expect(suppression(quiet, "Asia/Shanghai", at("2026-11-04T00:00:00Z"))).toBeNull();
    expect(suppression(quiet, "Asia/Shanghai", at("2026-11-03T13:59:00Z"))).toBeNull();
    // The same instant is outside them in UTC.
    expect(suppression(quiet, "UTC", at("2026-11-03T14:30:00Z"))).toBeNull();
    // Switched off, nothing is quiet.
    expect(
      suppression(
        settings({ quietHours: { ...quiet.quietHours, enabled: false } }),
        "Asia/Shanghai",
        at("2026-11-03T14:30:00Z"),
      ),
    ).toBeNull();
  });

  test("a window within one day, and an unknown zone read as UTC", () => {
    const lunch = settings({
      quietHours: { enabled: true, startMinute: 12 * 60, endMinute: 13 * 60 },
    });
    expect(suppression(lunch, "UTC", at("2026-11-03T12:00:00Z"))).toBe("quiet_hours");
    expect(suppression(lunch, "UTC", at("2026-11-03T13:00:00Z"))).toBeNull();
    expect(suppression(lunch, "Not/AZone", at("2026-11-03T12:30:00Z"))).toBe("quiet_hours");
  });
});

describe("a phone's notification while the computer is in use", () => {
  const now = at("2026-11-03T10:00:00Z");
  const using = {
    lastInputAt: new Date(now.getTime() - MINUTE),
    reportedAt: new Date(now.getTime() - 30_000),
  };

  test("immediate never waits; no computer report never waits", () => {
    expect(mobileDeferredUntil("immediate", using, now)).toBeNull();
    for (const delay of ["inactive", "idle_1m", "idle_10m"] as const)
      expect(mobileDeferredUntil(delay, null, now)).toBeNull();
  });

  test("inactive waits until the computer stops being in use", () => {
    // In use until 3 minutes after the last input, unless the reports stop first (150 seconds).
    expect(mobileDeferredUntil("inactive", using, now)).toEqual(
      new Date(now.getTime() + 2 * MINUTE),
    );
    const lateReport = {
      lastInputAt: new Date(now.getTime() - 10_000),
      reportedAt: new Date(now.getTime() - 120_000),
    };
    expect(mobileDeferredUntil("inactive", lateReport, now)).toEqual(
      new Date(now.getTime() + 30_000),
    );
    // Input more than 3 minutes ago, or a report more than 150 seconds ago: not in use.
    expect(
      mobileDeferredUntil(
        "inactive",
        { lastInputAt: new Date(now.getTime() - 3 * MINUTE), reportedAt: now },
        now,
      ),
    ).toBeNull();
    expect(
      mobileDeferredUntil(
        "inactive",
        { lastInputAt: now, reportedAt: new Date(now.getTime() - 150_000) },
        now,
      ),
    ).toBeNull();
  });

  test("idle_Nm waits until N minutes after the last input", () => {
    // Asked again when the reports would go stale (150 seconds after the last), whichever is first;
    // a computer still in use by then has reported again, and the wait moves on.
    expect(mobileDeferredUntil("idle_5m", using, now)).toEqual(
      new Date(now.getTime() + 2 * MINUTE),
    );
    const fresh = { lastInputAt: new Date(now.getTime() - MINUTE), reportedAt: now };
    expect(mobileDeferredUntil("idle_5m", fresh, now)).toEqual(new Date(now.getTime() + 150_000));
    expect(mobileDeferredUntil("idle_2m", fresh, now)).toEqual(new Date(now.getTime() + MINUTE));
    expect(mobileDeferredUntil("idle_1m", using, now)).toBeNull();
    // The computer stopped reporting: nobody is at it, so the phone rings.
    const gone = {
      lastInputAt: new Date(now.getTime() - MINUTE),
      reportedAt: new Date(now.getTime() - 151_000),
    };
    expect(mobileDeferredUntil("idle_10m", gone, now)).toBeNull();
  });

  test("a focused page keeps reporting with no input, so a long idle wait can run its course", () => {
    // The page reports every minute while it is visible and focused, input or not: six minutes after
    // the last input it still says so, and idle_10m keeps waiting (asked again when this report goes
    // stale); idle_5m and inactive do not.
    const quietAtDesk = { lastInputAt: new Date(now.getTime() - 6 * MINUTE), reportedAt: now };
    expect(mobileDeferredUntil("idle_10m", quietAtDesk, now)).toEqual(
      new Date(now.getTime() + 150_000),
    );
    expect(mobileDeferredUntil("idle_5m", quietAtDesk, now)).toBeNull();
    expect(mobileDeferredUntil("inactive", quietAtDesk, now)).toBeNull();
  });
});

describe("what a notification shows", () => {
  const channel = { title: "#general", body: "Alice: ship it", sender: "Alice" };
  const direct = { title: "Alice", body: "ship it", sender: "Alice" };

  test("full shows everything; sender only the sender; hidden nothing", () => {
    expect(previewNotification(channel, "full", "en")).toEqual({
      title: "#general",
      body: "Alice: ship it",
    });
    expect(previewNotification(channel, "sender", "en")).toEqual({
      title: "#general",
      body: "Alice sent a message",
    });
    expect(previewNotification(direct, "sender", "en")).toEqual({
      title: "Alice",
      body: "Alice sent a message",
    });
    expect(previewNotification(channel, "hidden", "en")).toEqual({
      title: "CoForge",
      body: "New message",
    });
    expect(previewNotification(channel, "hidden", "zh-CN")).toEqual({
      title: "CoForge",
      body: "有一条新消息",
    });
  });

  test("a server notice has no sender: sender mode hides its text", () => {
    const notice = { title: "#general", body: "Alice joined", sender: null };
    expect(previewNotification(notice, "sender", "en")).toEqual({
      title: "#general",
      body: "New message",
    });
  });
});
