import { expect, test } from "bun:test";
import { runCli } from "#src/cli";
import { describeUpgradePlan, planUpgrade } from "#src/cli/upgrade-plan";

test("the plan orders release versions and refuses a downgrade without the flag", () => {
  expect(planUpgrade("1.0.17", "1.0.17", false)).toEqual({
    kind: "up-to-date",
    version: "1.0.17",
  });
  expect(planUpgrade("1.0.17", "1.0.18", false)).toEqual({
    kind: "upgrade",
    current: "1.0.17",
    target: "1.0.18",
    refused: false,
  });
  expect(planUpgrade("1.0.18", "1.0.17", false)).toMatchObject({
    kind: "downgrade",
    refused: true,
  });
  expect(planUpgrade("1.0.18", "1.0.17", true)).toMatchObject({
    kind: "downgrade",
    refused: false,
  });
  // A prerelease of the same core is older than the release.
  expect(planUpgrade("0.1.1", "0.1.1-dev.10", false)).toMatchObject({ kind: "downgrade" });
});

test("nothing installed needs no flag; a version that cannot be ordered is refused without it", () => {
  expect(planUpgrade(null, "1.0.18", false)).toEqual({
    kind: "install",
    current: null,
    target: "1.0.18",
    refused: false,
  });
  // The installer cannot order a non-SemVer version, so it refuses it like a downgrade.
  expect(planUpgrade("local-build", "1.0.18", false)).toEqual({
    kind: "unordered",
    current: "local-build",
    target: "1.0.18",
    refused: true,
  });
  expect(planUpgrade("local-build", "1.0.18", true)).toMatchObject({ refused: false });
});

test("the report names the exact version to apply, and exits 1 only when it would refuse", () => {
  expect(describeUpgradePlan(planUpgrade("1.0.17", "1.0.18", false))).toEqual({
    lines: [
      "Dry run: nothing was downloaded, installed, or stopped.",
      "Installed: 1.0.17",
      "Target: 1.0.18",
      "Would upgrade: 1.0.17 -> 1.0.18",
      "To apply, run: coforge-computer upgrade --version 1.0.18",
    ],
    exitCode: 0,
  });
  expect(describeUpgradePlan(planUpgrade("1.0.18", "1.0.17", false))).toEqual({
    lines: [
      "Dry run: nothing was downloaded, installed, or stopped.",
      "Installed: 1.0.18",
      "Target: 1.0.17",
      "Would refuse: 1.0.17 is older than the installed 1.0.18.",
      "To go ahead anyway, run: coforge-computer upgrade --version 1.0.17 --allow-downgrade",
    ],
    exitCode: 1,
  });
  expect(describeUpgradePlan(planUpgrade("1.0.18", "1.0.17", true)).lines.at(-1)).toBe(
    "To apply, run: coforge-computer upgrade --version 1.0.17 --allow-downgrade",
  );
  expect(describeUpgradePlan(planUpgrade(null, "1.0.18", false)).lines).toEqual([
    "Dry run: nothing was downloaded, installed, or stopped.",
    "Installed: none",
    "Target: 1.0.18",
    "Would install: 1.0.18",
    "To apply, run: coforge-computer upgrade --version 1.0.18",
  ]);
  expect(describeUpgradePlan(planUpgrade("local-build", "1.0.18", false))).toMatchObject({
    lines: expect.arrayContaining([
      "Would refuse: 1.0.18 cannot be ordered against the installed local-build.",
    ]),
    exitCode: 1,
  });
  expect(describeUpgradePlan(planUpgrade("1.0.18", "1.0.18", false))).toEqual({
    lines: [
      "Dry run: nothing was downloaded, installed, or stopped.",
      "Already up to date: 1.0.18",
    ],
    exitCode: 0,
  });
});

/** An updater that records every call, so a dry run can be shown to make none that change state. */
function recordingUpdater(current: string | null, target: string) {
  const calls: string[] = [];
  return {
    calls,
    updater: {
      async resolveVersion(selector: string) {
        calls.push(`resolve ${selector}`);
        return target;
      },
      async getCurrentVersion() {
        calls.push("current");
        return current;
      },
      async install() {
        calls.push("install");
      },
      async upgrade() {
        calls.push("upgrade");
      },
      async recover() {
        calls.push("recover");
        return 0;
      },
    },
  };
}

test("upgrade --dry-run reports without prompting, installing, or upgrading", async () => {
  const { calls, updater } = recordingUpdater("1.0.17", "1.0.18");
  const output: string[] = [];
  const questions: string[] = [];
  const exitCode = await runCli(
    ["upgrade", "--dry-run"],
    { login: { async run() {} }, setup: { async run() {} }, updater },
    {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      prompt: (question) => {
        questions.push(question);
        return "y";
      },
    },
  );
  expect(exitCode).toBe(0);
  expect(questions).toEqual([]);
  expect(calls).toEqual(["resolve latest", "current"]);
  expect(output).toContain("Would upgrade: 1.0.17 -> 1.0.18");
});

test("upgrade --dry-run exits 1 for a downgrade the installer would refuse", async () => {
  const { calls, updater } = recordingUpdater("1.0.18", "1.0.17");
  const output: string[] = [];
  const exitCode = await runCli(
    ["upgrade", "--version", "1.0.17", "--dry-run"],
    { login: { async run() {} }, setup: { async run() {} }, updater },
    { stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
  );
  expect(exitCode).toBe(1);
  expect(calls).toEqual(["resolve 1.0.17", "current"]);
  expect(output).toContain(
    "To go ahead anyway, run: coforge-computer upgrade --version 1.0.17 --allow-downgrade",
  );
});
