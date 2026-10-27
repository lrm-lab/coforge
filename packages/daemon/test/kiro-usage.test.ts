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
  #resolveExit?: (code: number) => void;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = (async function* () {})();
  killed = false;

  constructor(output: string, exitCode = 0, pending = false) {
    this.exited = pending
      ? new Promise((resolve) => {
          this.#resolveExit = resolve;
        })
      : Promise.resolve(exitCode);
    this.stdout = (async function* () {
      if (output) yield new TextEncoder().encode(output);
    })();
  }

  kill() {
    this.killed = true;
    this.#resolveExit?.(137);
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
  trees: FixtureTree | readonly FixtureTree[],
  calls: { command?: readonly string[]; cwd?: string; env?: Record<string, string> },
): ProcessTreeSpawner {
  const queue = Array.isArray(trees) ? [...trees] : [trees];
  return {
    spawn(command, cwd, environment) {
      calls.command = command;
      calls.cwd = cwd;
      calls.env = { ...environment };
      const tree = queue.shift();
      if (!tree) throw new Error("unexpected extra Kiro process");
      return tree;
    },
  };
}

test("runs the official usage slash command in the requested workspace", async () => {
  const whoami = new FixtureTree('{"account":{"accountType":"IamIdentityCenter"}}', 1);
  const tree = new FixtureTree(USAGE);
  const calls: { command?: readonly string[]; cwd?: string; env?: Record<string, string> } = {};
  const commands: string[][] = [];
  const spawn = spawner([whoami, tree], calls);
  const removed: string[] = [];
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1000,
      environment: { PATH: "/fixture" },
      spawn: {
        spawn(command, cwd, environment, options) {
          commands.push([...command]);
          return spawn.spawn(command, cwd, environment, options);
        },
      },
      resolveExecutable: () => "/opt/homebrew/bin/kiro-cli",
      tempDirectory: {
        create: async () => "/tmp/empty-kiro-usage",
        remove: async (path) => {
          removed.push(path);
        },
      },
    }),
  ).resolves.toBe(USAGE);
  expect(commands).toEqual([
    [commands[0]![0]!, "whoami", "--format", "json"],
    [commands[1]![0]!, "chat", "--no-interactive", "/usage"],
  ]);
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
  const whoami = new FixtureTree('{"account":{"accountType":"IamIdentityCenter"}}');
  const tree = new FixtureTree("", 0, true);
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 20,
      spawn: spawner([whoami, tree], {}),
    }),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
  expect(tree.terminated).toBe(true);
  expect(tree.child.killed).toBe(true);
});

test("rejects a non-zero native command without exposing its output", async () => {
  const whoami = new FixtureTree('{"account":{"accountType":"IamIdentityCenter"}}');
  const tree = new FixtureTree("fixture-secret", 1);
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1000,
      spawn: spawner([whoami, tree], {}),
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

test("does not start chat usage when whoami reports a null account", async () => {
  const whoami = new FixtureTree('{"account":null}', 1);
  const calls: string[][] = [];
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1000,
      spawn: {
        spawn(command) {
          calls.push([...command]);
          return spawner(whoami, {}).spawn(command, "/tmp", {});
        },
      },
    }),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
  expect(calls[0]?.slice(1)).toEqual(["whoami", "--format", "json"]);
});

test("stops usage immediately when the native output starts device login", async () => {
  const whoami = new FixtureTree('{"account":{"accountType":"IamIdentityCenter"}}');
  const tree = new FixtureTree(
    "Confirm the following code in the browser\nCode: XXXX-XXXX\nOpen this URL: https://view.awsapps.com/start/#/device?user_code=XXXX-XXXX",
    0,
    true,
  );
  const startedAt = performance.now();
  await expect(
    readKiroUsageResponse({
      workingDirectory: "/tmp/kiro-project",
      timeoutMs: 1000,
      spawn: spawner([whoami, tree], {}),
    }),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
  expect(performance.now() - startedAt).toBeLessThan(100);
  expect(tree.terminated).toBe(true);
  expect(tree.child.killed).toBe(true);
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
