import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeCodeUsage } from "./fixtures/claude-host";
import { UsageUnavailableError, UsageUnsupportedError } from "@lrm/coforge-anvil";

const fixture = new URL("./fixtures/claude-usage-control.ts", import.meta.url).pathname;
const scratch: string[] = [];
const directory = async () => {
  const created = await mkdtemp(join(tmpdir(), "coforge-claude-usage-control-"));
  scratch.push(created);
  return created;
};
const read = async (
  mode: string,
  extra: Parameters<typeof readClaudeCodeUsage>[1] = {},
  planTier?: string,
) =>
  readClaudeCodeUsage(
    await directory(),
    {
      command: [process.execPath, fixture, mode],
      timeoutMs: 5_000,
      ...extra,
    },
    planTier,
  );

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("maps the structured response to the usage snapshot", async () => {
  const result = await read("ok");
  expect(result).toEqual({
    provider: "claude-code",
    planType: "Max",
    accountLabel: "fra****n@example.com",
    primary: { usedPercent: 26, windowDurationMinutes: 300, resetsAt: "2026-10-22T18:00:00.381Z" },
    secondary: {
      usedPercent: 100,
      windowDurationMinutes: 10080,
      resetsAt: "2026-10-28T13:00:00.381Z",
    },
    officialGroups: [
      {
        buckets: [
          {
            name: "Current session",
            usedPercent: 26,
            status: "ok",
            windowDurationMinutes: 300,
            resetsAt: "2026-10-22T18:00:00.381Z",
          },
          {
            name: "Current week (all models)",
            usedPercent: 100,
            status: "limit_reached",
            windowDurationMinutes: 10080,
            resetsAt: "2026-10-28T13:00:00.381Z",
          },
          {
            name: "Current week (Fable)",
            usedPercent: 7,
            status: "ok",
            windowDurationMinutes: 10080,
            resetsAt: "2026-10-28T13:00:00.000Z",
          },
          {
            name: "Current week (Sonnet)",
            usedPercent: 3,
            status: "ok",
            windowDurationMinutes: 10080,
            resetsAt: "2026-10-28T13:00:00.000Z",
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("frank.an");
});

test("ignores unrelated protocol lines while waiting for the matching response", async () => {
  expect((await read("noise"))?.primary?.usedPercent).toBe(26);
});

test("returns null when Claude Code is not signed in", async () => {
  expect(await read("logged-out")).toBeNull();
  expect(await read("auth-error")).toBeNull();
  expect(await read("usage-auth-error")).toBeNull();
  expect(await read("usage-401")).toBeNull();
});

test("keeps the model-scoped week from rate_limits", async () => {
  const names = (await read("ok"))?.officialGroups?.[0]?.buckets.map((item) => item.name);
  expect(names).toContain("Current week (Fable)");
});

test("skips malformed optional buckets and keeps the session", async () => {
  const result = await read("bad-optional");
  expect(result?.officialGroups?.[0]?.buckets.map((item) => item.name)).toEqual([
    "Current session",
  ]);
});

test("keeps utilization above 100 as a reached limit", async () => {
  const result = await read("overage");
  expect(result?.primary?.usedPercent).toBe(130);
  expect(result?.officialGroups?.[0]?.buckets[0]?.status).toBe("limit_reached");
});

test("an account with only a provider and organization is not signed in", async () => {
  expect(await read("api-only")).toBeNull();
});

test("reports an account without plan limits as unsupported", async () => {
  await expect(read("no-limits")).rejects.toBeInstanceOf(UsageUnsupportedError);
});

test.each([
  "all-null",
  "bad-percent",
  "bad-shape",
  "usage-service-error",
  "init-network-error",
  "help-fails",
  "missing-body",
  "malformed-init",
  "usage-error",
  "crash",
])("%s is unavailable and never falls back to the text report", async (mode) => {
  await expect(read(mode)).rejects.toBeInstanceOf(UsageUnavailableError);
});

test("falls back to the text report when the CLI has no --safe-mode", async () => {
  const result = await read("old");
  expect(result?.primary?.usedPercent).toBe(25);
  expect(result?.planType).toBe("pro");
});

test("falls back to the text report when get_usage is an unsupported subtype", async () => {
  const result = await read("unsupported-subtype");
  expect(result?.primary?.usedPercent).toBe(25);
});

test("times out and kills the Claude Code child", async () => {
  const dir = await directory();
  const pidFile = join(dir, "pid");
  await expect(
    read("hang", { timeoutMs: 2_000, environment: { CLAUDE_FAKE_PID_FILE: pidFile } }),
  ).rejects.toThrow("Claude Code usage request timed out");
  const pid = Number(await Bun.file(pidFile).text());
  expect(pid).toBeGreaterThan(0);
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(20);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
});

test("an account without a 5-hour limit reports only its weekly window", async () => {
  // The expected Ultra shape (Anthropic's $200 plan): `five_hour` is null, so the snapshot has no
  // primary window at all rather than an empty one. Constructed, not observed yet.
  const result = await read("ultra");
  expect(result).not.toHaveProperty("primary");
  expect(result?.planType).toBe("Ultra");
  expect(result?.secondary).toEqual({
    usedPercent: 35,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-11-06T06:59:59.000Z",
  });
  expect(result?.officialGroups?.[0]?.buckets.map((bucket) => bucket.name)).toEqual([
    "Current week (all models)",
  ]);
});

test("the rate-limit tier names the plan when subscription_type cannot", async () => {
  // Both paid Max plans answer `subscription_type: "max"`; only the tier tells them apart, and
  // Anthropic now calls the $200 one Ultra.
  expect((await read("ok", {}, "default_claude_max_20x"))?.planType).toBe("Ultra");
  expect((await read("ok", {}, "default_claude_max_5x"))?.planType).toBe("Max");
  // No tier known: the protocol's own word, capitalised.
  expect((await read("ok"))?.planType).toBe("Max");
});
