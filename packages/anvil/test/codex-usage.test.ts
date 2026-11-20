import { fixtureCodexHost } from "./fixtures/codex-host";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageUnavailableError, UsageUnsupportedError } from "@lrm/coforge-anvil";
import { readCodexUsage } from "@lrm/coforge-anvil/codex";

const fixture = new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname;

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-usage-"));
  scratchDirectories.push(directory);
  return directory;
}

/** The window id: `w<index>_<first 12 hex of sha256(label)>`. */
function windowId(label: string, index: number): string {
  return `w${index}_${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}

test("reads Codex account usage and converts rate-limit windows", async () => {
  const result = await readCodexUsage(await scratchDirectory(), {
    host: fixtureCodexHost,
    command: [process.execPath, fixture, "usage"],
  });
  expect(result).toEqual({
    provider: "codex",
    planType: "plus",
    primary: {
      id: windowId("Codex · 5 hours", 0),
      usedPercent: 25,
      status: "ok",
      windowDurationMinutes: 300,
      resetsAt: "2025-01-02T01:20:00.000Z",
    },
    secondary: {
      id: windowId("Codex · 1 week", 1),
      usedPercent: 75,
      status: "ok",
      windowDurationMinutes: 10080,
      resetsAt: "2026-01-09T00:00:00.000Z",
    },
    accountLabel: "cod****er@example.com",
    health: "ok",
    officialGroups: [
      {
        name: "Codex",
        buckets: [
          {
            window: "primary",
            usedPercent: 25,
            status: "ok",
            windowDurationMinutes: 300,
            resetsAt: "2025-01-02T01:20:00.000Z",
          },
          {
            window: "secondary",
            usedPercent: 75,
            status: "ok",
            windowDurationMinutes: 10_080,
            resetsAt: "2026-01-09T00:00:00.000Z",
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("codexuser");
});

test("returns no snapshot when Codex is not logged in or does not support the method", async () => {
  const directory = await scratchDirectory();
  for (const flag of ["usage-unavailable", "usage-unsupported", "usage-auth"]) {
    expect(
      await readCodexUsage(directory, {
        host: fixtureCodexHost,
        command: [process.execPath, fixture, flag],
      }),
    ).toBeNull();
  }
});

test("answers unsupported for a non-subscription account", async () => {
  const directory = await scratchDirectory();
  for (const flag of ["usage-apikey", "usage-noauth"]) {
    await expect(
      readCodexUsage(directory, {
        host: fixtureCodexHost,
        command: [process.execPath, fixture, flag],
      }),
    ).rejects.toThrow(UsageUnsupportedError);
  }
});

test("scans an app-server that predates account/read, without the account label", async () => {
  const result = await readCodexUsage(await scratchDirectory(), {
    host: fixtureCodexHost,
    command: [process.execPath, fixture, "usage-legacy"],
  });
  expect(result?.accountLabel).toBeUndefined();
  expect(result?.planType).toBe("plus");
  expect(result?.primary?.usedPercent).toBe(25);
  expect(result?.health).toBe("ok");
});

test("reports a limit-reached window and rate_limited account health", async () => {
  const result = await readCodexUsage(await scratchDirectory(), {
    host: fixtureCodexHost,
    command: [process.execPath, fixture, "usage-ratelimited"],
  });
  expect(result?.primary?.status).toBe("limit_reached");
  expect(result?.primary?.usedPercent).toBe(100);
  expect(result?.health).toBe("rate_limited");
});

test("Codex credits cover an exhausted weekly allowance while preserving other limits", async () => {
  const directory = await scratchDirectory();
  const weekly = { usedPercent: 100, windowDurationMins: 10_080 };
  const short = { usedPercent: 100, windowDurationMins: 300 };
  const credits = { hasCredits: true, unlimited: false, balance: "12.50" };
  const base = { limitId: "codex", planType: "plus", primary: weekly, credits };
  const read = (
    overrides: Record<string, unknown> = {},
    codexGroupOverrides: Record<string, unknown> = {},
  ) => {
    const rateLimits = { ...base, ...overrides };
    const scenario = {
      rateLimits,
      rateLimitsByLimitId: {
        codex: { ...rateLimits, ...codexGroupOverrides },
        "other-model": { primary: weekly },
      },
      rateLimitResetCredits: { availableCount: 2 },
    };
    return readCodexUsage(directory, {
      host: fixtureCodexHost,
      command: [process.execPath, fixture, `usage-snapshot=${JSON.stringify(scenario)}`],
    });
  };
  const funded = await read();
  expect(funded).toMatchObject({
    health: "ok",
    primary: { usedPercent: 100, status: "ok" },
    credits,
    resetCreditsAvailable: 2,
  });
  expect(funded?.officialGroups?.[0]?.buckets[0]).toMatchObject({
    usedPercent: 100,
    status: "ok",
  });
  expect(funded?.officialGroups?.[1]?.buckets[0]?.status).toBe("limit_reached");

  for (const overrides of [
    { credits: { hasCredits: false, unlimited: false, balance: "0" } },
    { credits: { ...credits, balance: "0.00" } },
    { secondary: short },
    { rateLimitReachedType: "workspace_owner_usage_limit_reached" },
    { spendControlReached: true },
  ]) {
    expect(await read(overrides)).toMatchObject({
      health: "rate_limited",
      resetCreditsAvailable: 2,
    });
  }
  expect(await read({ primary: undefined, secondary: weekly })).toMatchObject({
    health: "ok",
    secondary: { usedPercent: 100, status: "ok" },
  });
  const explicitGroupLimit = await read(
    {},
    {
      primary: { ...weekly, usedPercent: 60 },
      rateLimitReachedType: "workspace_owner_usage_limit_reached",
    },
  );
  expect(explicitGroupLimit).toMatchObject({
    health: "rate_limited",
    primary: { usedPercent: 100, status: "limit_reached" },
    resetCreditsAvailable: 2,
  });
  expect(explicitGroupLimit?.officialGroups?.[0]?.buckets[0]).toMatchObject({ usedPercent: 60 });

  const emptyCredits = { hasCredits: false, unlimited: false, balance: "0" };
  expect(await read({}, { credits: emptyCredits })).toMatchObject({
    health: "rate_limited",
    credits: emptyCredits,
    primary: { status: "limit_reached", usedPercent: 100 },
  });
  expect(await read({ credits: emptyCredits }, { credits })).toMatchObject({
    health: "ok",
    credits,
    primary: { status: "ok", usedPercent: 100 },
  });
  expect(await read({}, { credits: undefined })).toMatchObject({
    health: "ok",
    credits,
    primary: { status: "ok", usedPercent: 100 },
  });
});

test("errors clearly when a signed-in account yields no usable window", async () => {
  const directory = await scratchDirectory();
  await expect(
    readCodexUsage(directory, {
      host: fixtureCodexHost,
      command: [process.execPath, fixture, "usage-empty"],
    }),
  ).rejects.toThrow(UsageUnavailableError);
});

test("keeps every limit name, an extra limit, and the schema balance, not credit amounts", async () => {
  const result = await readCodexUsage(await scratchDirectory(), {
    host: fixtureCodexHost,
    command: [process.execPath, fixture, "usage-extra"],
  });
  expect(result?.creditUsage).toBeUndefined();
  expect(result?.credits).toEqual({ hasCredits: true, unlimited: false, balance: "12.50" });
  expect(result?.officialGroups?.map((group) => group.name)).toEqual(["Codex", "GPT-5"]);
  expect(result?.officialGroups?.[1]?.buckets).toEqual([
    {
      window: "primary",
      usedPercent: 10,
      status: "ok",
      windowDurationMinutes: 300,
      resetsAt: "2025-01-02T01:20:00.000Z",
    },
  ]);
  expect(result?.officialGroups?.[0]?.buckets.map((bucket) => bucket.window)).toEqual([
    "primary",
    "secondary",
    "individualLimit",
  ]);
  expect(result?.officialGroups?.[0]?.buckets[2]).toMatchObject({
    remainingFraction: 0.4,
    description: "3 / 10",
  });
});

test("fails clearly when the Codex usage request times out", async () => {
  const directory = await scratchDirectory();
  await expect(
    readCodexUsage(directory, {
      host: fixtureCodexHost,
      command: [process.execPath, fixture, "usage-timeout"],
      timeoutMs: 20,
    }),
  ).rejects.toThrow("Codex usage request timed out");
});

test("reports how many reset credits the account can spend, when that is a plausible count", async () => {
  const directory = await scratchDirectory();
  const read = (credits?: string) =>
    readCodexUsage(directory, {
      host: fixtureCodexHost,
      command: [
        process.execPath,
        fixture,
        ...(credits === undefined ? [] : [`usage-credits=${credits}`]),
      ],
    });
  expect((await read("2"))?.resetCreditsAvailable).toBe(2);
  expect((await read("0"))?.resetCreditsAvailable).toBe(0);
  expect((await read("999"))?.resetCreditsAvailable).toBe(999);
  for (const implausible of ["1000", "-1", "1.5", '"3"', "null"])
    expect((await read(implausible))?.resetCreditsAvailable).toBeUndefined();
  expect((await read())?.resetCreditsAvailable).toBeUndefined();
});
