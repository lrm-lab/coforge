import { expect, test } from "bun:test";
import {
  UsageUnavailableError,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "@lrm/coforge-anvil";
import { readKiroUsageResponse } from "#src/code-agent/kiro/usage-host";
import { usageScanFailure } from "#src/daemon-runtime/usage-scan-response";

const USAGE = `Estimated Usage | resets on 2026-11-01 | KIRO POWER
Credits (10000.00 of 10000 covered in plan), 100.0%
Your plan is managed by your organization's administrator.`;

class FixtureChild implements OwnedChildProcess {
  readonly pid = 42;
  readonly exitCode = 0;
  readonly stdin = { write: () => true, end: () => {}, flush: async () => {} };
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = (async function* () {})();
  killed = false;

  constructor(output: string, exitCode = 0, pending = false) {
    this.exited = pending ? new Promise(() => {}) : Promise.resolve(exitCode);
    this.stdout = (async function* () {
      if (output) yield new TextEncoder().encode(output);
    })();
  }

  kill() {
    this.killed = true;
  }
}

class FixtureTree implements OwnedProcessTree {
  readonly child: FixtureChild;
  terminated = false;

  constructor(output: string, exitCode = 0, pending = false) {
    this.child = new FixtureChild(output, exitCode, pending);
  }

  async terminate() {
    this.terminated = true;
    this.child.kill();
  }

  async waitForExit() {
    return this.terminated;
  }
}

function spawner(
  tree: FixtureTree,
  calls: { command?: readonly string[]; cwd?: string; env?: Record<string, string> },
): ProcessTreeSpawner {
  return {
    spawn(command, cwd, environment) {
      calls.command = command;
      calls.cwd = cwd;
      calls.env = { ...environment };
      return tree;
    },
  };
}

test("runs the official usage slash command in the requested workspace", async () => {
  const tree = new FixtureTree(USAGE);
  const calls: { command?: readonly string[]; cwd?: string; env?: Record<string, string> } = {};
  const removed: string[] = [];
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1000,
      environment: { PATH: "/fixture" },
      spawn: spawner(tree, calls),
      resolveExecutable: () => "/opt/homebrew/bin/kiro-cli",
      tempDirectory: {
        create: async () => "/tmp/empty-kiro-usage",
        remove: async (path) => {
          removed.push(path);
        },
      },
    }),
  ).resolves.toBe(USAGE);
  expect(calls.command).toEqual([
    "/opt/homebrew/bin/kiro-cli",
    "chat",
    "--no-interactive",
    "/usage",
  ]);
  expect(calls.cwd).toBe("/tmp/empty-kiro-usage");
  expect(calls.env?.NO_COLOR).toBe("1");
  expect(calls.env?.TERM).toBe("dumb");
  expect(calls.env?.PATH).toContain("/fixture");
  expect(removed).toEqual(["/tmp/empty-kiro-usage"]);
  expect(tree.terminated).toBe(true);
});

test("cleans up the owned process tree when the usage command times out", async () => {
  const tree = new FixtureTree("", 0, true);
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1,
      spawn: spawner(tree, {}),
    }),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
  expect(tree.terminated).toBe(true);
  expect(tree.child.killed).toBe(true);
});

test("rejects a non-zero native command without exposing its output", async () => {
  const tree = new FixtureTree("fixture-secret", 1);
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1000,
      spawn: spawner(tree, {}),
    }),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
});

test("classifies an unavailable executable as unavailable usage", async () => {
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1000,
      spawn: {
        spawn: () => {
          throw new Error("ENOENT fixture-secret");
        },
      },
    }),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
});

test("keeps Kiro usage unavailable instead of turning it into a sign-in state", () => {
  expect(
    usageScanFailure(
      new UsageUnavailableError(),
      () => undefined,
      () => new Date(),
    ),
  ).toMatchObject({
    status: "unavailable",
    message: "Provider usage is unavailable",
  });
});
