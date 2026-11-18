import { expect, test } from "bun:test";
import { shouldRecordObservedTimeZone } from "#src/features/settings/use-time-zone-cookie";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";
import { PrismaUserPreferencesRepository } from "#src/server/db/repositories/user-preferences.repositories.server";
import { Reminders } from "#src/server/reminders/reminders.server";

function makeRepo(pref: { timeZone: string | null; observedTimeZone: string | null } | null) {
  const db = {
    agent: {
      findUnique: async () => ({ owner: { preferences: pref } }),
    },
  };
  return new PrismaReminderRepository(db as never);
}

test("PrismaReminderRepository.defaultTimezone prefers explicit timeZone, then observedTimeZone, then Asia/Shanghai", async () => {
  const scope = { workspaceId: "w1", computerId: "c1", agentId: "a1", userId: "u1" };
  expect(
    await makeRepo({
      timeZone: "America/New_York",
      observedTimeZone: "Europe/London",
    }).defaultTimezone(scope),
  ).toBe("America/New_York");
  expect(
    await makeRepo({ timeZone: null, observedTimeZone: "America/Los_Angeles" }).defaultTimezone(
      scope,
    ),
  ).toBe("America/Los_Angeles");
  expect(await makeRepo({ timeZone: null, observedTimeZone: null }).defaultTimezone(scope)).toBe(
    "Asia/Shanghai",
  );
  expect(
    await makeRepo({
      timeZone: "Invalid/Zone",
      observedTimeZone: "America/Los_Angeles",
    }).defaultTimezone(scope),
  ).toBe("America/Los_Angeles");
  expect(await makeRepo(null).defaultTimezone(scope)).toBe("Asia/Shanghai");
});

test("shouldRecordObservedTimeZone reports when browser zone differs from server observedTimeZone even if cookie already existed", () => {
  expect(shouldRecordObservedTimeZone("America/Los_Angeles", null)).toBe(true);
  expect(shouldRecordObservedTimeZone("America/Los_Angeles", "Europe/London")).toBe(true);
  expect(shouldRecordObservedTimeZone("America/Los_Angeles", "America/Los_Angeles")).toBe(false);
  expect(shouldRecordObservedTimeZone(null, null)).toBe(false);
});

test("Reminders.execute uses repository.defaultTimezone when timezone is omitted and honors explicit timezone", async () => {
  let createdTimezone: string | undefined;
  const repo = {
    authorize: async () => true,
    authorizeDaemon: async () => ({ userId: "u1" }),
    defaultTimezone: async () => "America/Los_Angeles",
    resolveAnchor: async () => ({
      messageId: "019c0000-0000-7000-8000-000000000002",
      target: "@ada",
    }),
    create: async (
      _scope: unknown,
      _reqId: string,
      _fp: string,
      input: { timezone?: string; fireAt: string },
    ) => {
      createdTimezone = input.timezone;
      return {
        reminderId: "019c0000-0000-7000-8000-000000000001",
        ownerAgentId: "a1",
        computerId: "c1",
        title: "Standup",
        target: "@ada",
        messageId: "019c0000-0000-7000-8000-000000000002",
        fireAt: input.fireAt,
        repeat: "every:1d",
        timezone: input.timezone,
        status: "scheduled" as const,
        createdAt: "2026-11-18T00:00:00.000Z",
      };
    },
    list: async () => [],
    get: async () => undefined,
    update: async () => {
      throw new Error("unused");
    },
    acknowledge: async () => {
      throw new Error("unused");
    },
    events: async () => [],
  };
  const service = new Reminders(
    repo as never,
    { supports: async () => true },
    async () => undefined,
    () => new Date("2026-11-18T00:00:00.000Z"),
  );

  const withoutTz = await service.execute(
    {
      idempotencyKey: "k1",
      workspaceId: "w1",
      computerId: "c1",
      agentId: "a1",
      operation: "schedule",
      target: "@ada",
      messageId: "019c0000-0000-7000-8000-000000000002",
      title: "Standup",
      repeat: "every:1d",
    },
    "u1",
  );
  expect(createdTimezone).toBe("America/Los_Angeles");
  expect(withoutTz.reminders[0]!.timezone).toBe("America/Los_Angeles");

  const legacyTz = await service.execute(
    {
      idempotencyKey: "k2",
      workspaceId: "w1",
      computerId: "c1",
      agentId: "a1",
      operation: "schedule",
      target: "@ada",
      messageId: "019c0000-0000-7000-8000-000000000002",
      title: "Standup",
      repeat: "every:1d",
      timezone: "Asia/Shanghai",
    },
    "u1",
  );
  expect(createdTimezone).toBe("Asia/Shanghai");
  expect(legacyTz.reminders[0]!.timezone).toBe("Asia/Shanghai");
});

test("PrismaUserPreferencesRepository.setObservedTimeZone skips DB writes when unchanged", async () => {
  let writes = 0;
  let storedObserved: string | null = null;
  const db = {
    userPreference: {
      findUnique: async () => ({
        userId: "u1",
        timeZone: null,
        observedTimeZone: storedObserved,
        browserNotificationsEnabled: null,
        timeFormat: null,
        language: null,
      }),
      upsert: async ({ update }: { update: { observedTimeZone?: string } }) => {
        writes++;
        if (update.observedTimeZone) storedObserved = update.observedTimeZone;
        return { observedTimeZone: storedObserved };
      },
    },
  };
  const prefs = new PrismaUserPreferencesRepository(db as never);
  await prefs.setObservedTimeZone("u1", "America/Los_Angeles");
  expect(writes).toBe(1);
  await prefs.setObservedTimeZone("u1", "America/Los_Angeles");
  expect(writes).toBe(1);
});
