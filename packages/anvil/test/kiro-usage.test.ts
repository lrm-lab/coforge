import { expect, test } from "bun:test";
import { UsageUnavailableError } from "@lrm/coforge-anvil";
import { readKiroUsage } from "@lrm/coforge-anvil/kiro";

const USAGE = `Estimated Usage | resets on 2026-11-01 | KIRO POWER
Credits (10000.00 of 10000 covered in plan), 100.0%
Your plan is managed by your organization's administrator.`;

test("parses the official non-interactive usage output and marks a full plan", async () => {
  await expect(
    readKiroUsage({ workingDirectory: "/tmp/fixture", timeoutMs: 1000 }, async () => USAGE),
  ).resolves.toEqual({
    provider: "kiro",
    planType: "KIRO POWER",
    creditUsage: { used: 10000, limit: 10000, overage: 0 },
    primary: {
      usedPercent: 100,
      status: "limit_reached",
      windowDurationMinutes: 44640,
      resetsAt: "2026-11-01T00:00:00.000Z",
    },
    officialGroups: [
      {
        buckets: [
          {
            name: "Credits",
            window: "credit",
            usedPercent: 100,
            status: "limit_reached",
            windowDurationMinutes: 44640,
            resetsAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      },
    ],
  });
});

test("reads the same plan when the CLI adds notes under the credits line, as Linux 2.34.2 does", async () => {
  // Raw `kiro-cli chat --no-interactive "/usage"` from kiro-cli 2.34.2 on Linux (task #216).
  const linux = `Estimated Usage | resets on 2026-11-01 | KIRO POWER
Credits (10000.00 of 10000 covered in plan), 100.0%
Overages: Disabled
Your plan is managed by your organization's administrator.`;
  const mac = await readKiroUsage({ workingDirectory: "/tmp/fixture" }, async () => USAGE);
  await expect(
    readKiroUsage({ workingDirectory: "/tmp/fixture" }, async () => linux),
  ).resolves.toEqual(mac);
  await expect(
    readKiroUsage(
      { workingDirectory: "/tmp/fixture" },
      async () =>
        "Estimated Usage | resets on 2026-11-01 | KIRO POWER\nCredits (2500 of 10000 covered in plan), 25.0%",
    ),
  ).resolves.toMatchObject({ primary: { usedPercent: 25, status: "ok" } });
});

test("does not infer usage from a malformed or unsupported official response", async () => {
  for (const output of [
    undefined,
    "Not logged in. Run kiro-cli login.",
    "Estimated Usage | resets on 2026-11-01 | KIRO POWER\nCredits: unknown",
    "Estimated Usage | resets on 2026-11-01 | KIRO POWER\nCredits (100 of 200 covered in plan), 42.0%",
    "Estimated Usage | resets on 2026-11-01 | KIRO POWER\nCredits (200 of 100 covered in plan), 200.0%",
  ]) {
    await expect(
      readKiroUsage({ workingDirectory: "/tmp/fixture", timeoutMs: 1000 }, async () => output),
    ).rejects.toBeInstanceOf(UsageUnavailableError);
  }
});

test("passes the usage working directory and timeout to the host reader", async () => {
  let received: unknown;
  const result = await readKiroUsage(
    { workingDirectory: "/tmp/kiro-project", timeoutMs: 3210 },
    async (options) => {
      received = options;
      return USAGE;
    },
  );
  expect(received).toEqual({ workingDirectory: "/tmp/kiro-project", timeoutMs: 3210 });
  expect(result?.provider).toBe("kiro");
});
