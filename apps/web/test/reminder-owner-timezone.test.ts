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

test("PrismaReminderRepository.ownerTimeZone has no fallback, and execute reports it when known", async () => {
  const scope = { workspaceId: "w1", computerId: "c1", agentId: "a1", userId: "u1" };
  expect(
    await makeRepo({ timeZone: "America/New_York", observedTimeZone: null }).ownerTimeZone(scope),
  ).toBe("America/New_York");
  expect(
    await makeRepo({ timeZone: null, observedTimeZone: "America/Los_Angeles" }).ownerTimeZone(
      scope,
    ),
  ).toBe("America/Los_Angeles");
  expect(await makeRepo({ timeZone: null, observedTimeZone: null }).ownerTimeZone(scope)).toBe(
    undefined,
  );
  expect(
    await makeRepo({ timeZone: "Invalid/Zone", observedTimeZone: "Europe/London" }).ownerTimeZone(
      scope,
    ),
  ).toBe("Europe/London");

  const service = (ownerTimeZone: () => Promise<string | undefined>) =>
    new Reminders(
      {
        authorize: async () => true,
        list: async () => [],
        events: async () => [],
        ownerTimeZone,
      } as never,
      { supports: async () => true },
      async () => undefined,
    );
  const request = {
    idempotencyKey: "k1",
    workspaceId: "w1",
    computerId: "c1",
    agentId: "a1",
    operation: "list" as const,
  };
  expect((await service(async () => "Europe/Berlin").execute(request, "u1")).displayTimezone).toBe(
    "Europe/Berlin",
  );
  const log = {
    ...request,
    operation: "log" as const,
    reminderId: "019c0000-0000-7000-8000-000000000001",
  };
  expect((await service(async () => "Europe/Berlin").execute(log, "u1")).displayTimezone).toBe(
    "Europe/Berlin",
  );
  const unknown = await service(async () => undefined).execute(request, "u1");
  expect("displayTimezone" in unknown).toBe(false);
});

test("a replay keeps the owner time zone while an acknowledgement or dismissal reads none", async () => {
  const stored = {
    reminderId: "019c0000-0000-7000-8000-000000000001",
    ownerAgentId: "a1",
    computerId: "c1",
    version: 2,
    title: "Standup",
    target: "@ada",
    messageId: "019c0000-0000-7000-8000-000000000002",
    fireAt: "2026-11-19T17:00:00.000Z",
    repeat: "every:1d",
    timezone: "America/Los_Angeles",
    status: "delivered",
    createdAt: "2026-11-18T00:00:00.000Z",
    revision: 2,
  };
  const build = (replays: boolean) => {
    let lookups = 0;
    return {
      lookups: () => lookups,
      service: new Reminders(
        {
          authorize: async () => true,
          ownerTimeZone: async () => {
            lookups += 1;
            return "Europe/Berlin";
          },
          get: async () => stored,
          replay: replays ? async () => stored : undefined,
          acknowledge: async () => stored,
          list: async () => [],
        } as never,
        { supports: async () => true },
        async () => undefined,
      ),
    };
  };
  const scope = { idempotencyKey: "k1", workspaceId: "w1", computerId: "c1", agentId: "a1" };

  for (const operation of ["ack", "dismiss"] as const) {
    const { service, lookups } = build(false);
    const response = await service.execute(
      { ...scope, operation, reminderId: stored.reminderId, revision: 2 },
      "u1",
    );
    expect(response.reminders).toHaveLength(1);
    expect("displayTimezone" in response).toBe(false);
    expect(lookups()).toBe(0);
  }

  const replay = build(true);
  expect(
    (
      await replay.service.execute(
        { ...scope, operation: "snooze", reminderId: stored.reminderId, delaySeconds: 60 },
        "u1",
      )
    ).displayTimezone,
  ).toBe("Europe/Berlin");
  expect(replay.lookups()).toBe(1);
});

test("a failed display-zone lookup never turns a committed write into a failure", async () => {
  const stored = {
    reminderId: "019c0000-0000-7000-8000-000000000001",
    ownerAgentId: "a1",
    computerId: "c1",
    version: 1,
    title: "Standup",
    target: "@ada",
    messageId: "019c0000-0000-7000-8000-000000000002",
    fireAt: "2026-11-19T17:00:00.000Z",
    repeat: "every:1d",
    timezone: "America/Los_Angeles",
    status: "canceled",
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  const service = new Reminders(
    {
      authorize: async () => true,
      ownerTimeZone: async () => {
        throw new Error("preferences unavailable");
      },
      get: async () => stored,
      update: async () => stored,
      list: async () => [],
      events: async () => [],
    } as never,
    { supports: async () => true },
    async () => undefined,
  );
  const response = await service.execute(
    {
      idempotencyKey: "k1",
      workspaceId: "w1",
      computerId: "c1",
      agentId: "a1",
      operation: "cancel",
      reminderId: stored.reminderId,
    },
    "u1",
  );
  expect(response.reminders).toHaveLength(1);
  expect("displayTimezone" in response).toBe(false);
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
