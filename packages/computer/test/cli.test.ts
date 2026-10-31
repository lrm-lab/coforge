import { expect, test } from "bun:test";

import { runCli, type StatusCommand, type HostCommand } from "#src/cli";
import { reportSkippedRestarts } from "#src/cli/restart-supervisor";
import { nextUpgradeCommandHint, reportStoppedWorkspaces } from "#src/cli/upgrade-output";
import { UpgradeFailedError } from "#src/release/upgrade-receipt";
import { CliError } from "#src/errors";
import { COMPUTER_CLI_COMMANDS } from "@lrm/coforge-sdk/internal";

test("the CLI's actual registered commands match the shared COMPUTER_CLI_COMMANDS vocabulary", async () => {
  // Drift protection for apps/web's upgrade-failure copy (which names these commands, but does
  // not depend on this package): if a command here is renamed, added, or removed without
  // updating COMPUTER_CLI_COMMANDS, this fails instead of the two packages silently disagreeing.
  // `program.outputHelp()` writes straight to the real process streams (commander's default),
  // bypassing the `io` shim entirely - captured here instead of through `io`.
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCli([], { login: { async run() {} }, setup: { async run() {} } });
  } finally {
    process.stdout.write = originalWrite;
  }
  const lines = chunks.join("").split("\n");
  const commandsHeading = lines.indexOf("Commands:");
  expect(commandsHeading).toBeGreaterThanOrEqual(0);
  const names = new Set<string>();
  for (const line of lines.slice(commandsHeading + 1)) {
    const match = /^\s{2}(\S+)/.exec(line);
    if (!match) continue;
    const name = match[1]!.split("|")[0]!;
    if (name !== "help") names.add(name);
  }
  expect([...names].sort()).toEqual([...COMPUTER_CLI_COMMANDS].sort());
});

test("the upgrade CLI's next-command hint names the real commands for each outcome", () => {
  expect(nextUpgradeCommandHint(new Error("boom"))).toContain("coforge-computer status");
  expect(nextUpgradeCommandHint(new Error("boom"))).toContain("coforge-computer upgrade");

  const rolledBack = new UpgradeFailedError("candidate failed; previous version restored", {
    schema_version: 1,
    request_id: "r-1",
    operation: "upgrade",
    status: "failed",
    restoredVersion: "1.0.0",
  });
  expect(nextUpgradeCommandHint(rolledBack)).toContain("coforge-computer logs");
  expect(nextUpgradeCommandHint(rolledBack)).toContain("coforge-computer upgrade");

  const rollbackFailed = new UpgradeFailedError("candidate and rollback failed", {
    schema_version: 1,
    request_id: "r-2",
    operation: "upgrade",
    status: "failed",
    errorCode: "UPGRADE_ROLLBACK_FAILED",
  });
  expect(nextUpgradeCommandHint(rollbackFailed)).toContain("Run the same command again");
  expect(nextUpgradeCommandHint(rollbackFailed)).toContain("coforge-computer status");
});

test.each(["", "n", "no", "maybe", null])(
  "upgrade cancels without explicit consent: %s",
  async (answer) => {
    let upgrades = 0;
    const output: string[] = [];
    const questions: string[] = [];
    const exitCode = await runCli(
      ["upgrade"],
      {
        login: { async run() {} },
        setup: { async run() {} },
        updater: {
          async resolveVersion() {
            return "1.0.18";
          },
          async getCurrentVersion() {
            return "1.0.17";
          },
          async install() {},
          async upgrade() {
            upgrades += 1;
          },
          async repair() {
            return 0;
          },
        },
      },
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        prompt: (question) => {
          questions.push(question);
          return answer;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(upgrades).toBe(0);
    expect(questions).toEqual(["Upgrade CoForge Computer to 1.0.18? [y/N] "]);
    expect(output).toEqual(["Upgrade cancelled."]);
  },
);

test.each(["y", " YES "])(
  "install, upgrade, and repair run their own operations; upgrade requires consent: %s",
  async (answer) => {
    const calls: Array<{ operation: string; version?: string }> = [];
    const dependencies = {
      login: { async run() {} },
      setup: { async run() {} },
      updater: {
        async resolveVersion(selector: string) {
          expect(selector).toBe("latest");
          return "1.0.18";
        },
        async getCurrentVersion() {
          return "1.0.17";
        },
        async install(version: string) {
          calls.push({ operation: "install", version });
        },
        async upgrade(version: string) {
          calls.push({ operation: "upgrade", version });
        },
        async repair() {
          calls.push({ operation: "repair" });
          return 3;
        },
      },
    };

    await expect(runCli(["install"], dependencies)).resolves.toBe(0);
    const questions: string[] = [];
    await expect(
      runCli(["upgrade"], dependencies, {
        stdout: () => {},
        stderr: () => {},
        prompt: (question) => {
          questions.push(question);
          return answer;
        },
      }),
    ).resolves.toBe(0);
    expect(questions).toEqual(["Upgrade CoForge Computer to 1.0.18? [y/N] "]);
    await expect(
      runCli(
        [
          "install",
          "--version",
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    await expect(runCli(["repair"], dependencies)).resolves.toBe(3);

    expect(calls).toEqual([
      { operation: "install", version: "latest" },
      { operation: "upgrade", version: "1.0.18" },
      {
        operation: "install",
        version: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      { operation: "repair" },
    ]);
  },
);

test("post-upgrade hint reports each Workspace binding left stopped", () => {
  const output: string[] = [];
  reportStoppedWorkspaces(
    { stdout: (line) => output.push(line) },
    {
      supervisorRunning: true,
      runtimes: [
        { bindingId: "cc5c27ce-running", running: true },
        { bindingId: "cc5c27ce-stopped", running: false },
      ],
    },
  );
  expect(output).toEqual([
    "Workspace cc5c27ce-stopped was already stopped and stays stopped; run 'coforge-computer start' to bring it online.",
  ]);
});

test("post-upgrade hint says nothing when every Workspace binding is running", () => {
  const output: string[] = [];
  reportStoppedWorkspaces(
    { stdout: (line) => output.push(line) },
    { supervisorRunning: true, runtimes: [{ bindingId: "cc5c27ce-running", running: true }] },
  );
  expect(output).toEqual([]);
});

test("post-upgrade hint reports a stopped supervisor once instead of per-binding", () => {
  const output: string[] = [];
  reportStoppedWorkspaces(
    { stdout: (line) => output.push(line) },
    {
      supervisorRunning: false,
      runtimes: [{ bindingId: "cc5c27ce-stopped", running: false }],
    },
  );
  expect(output).toEqual([
    "Computer supervisor is not running; run 'coforge-computer start' to bring your Workspaces online.",
  ]);
});

test("restart hint reports each Workspace binding an unscoped restart skipped because it was disabled", () => {
  const output: string[] = [];
  reportSkippedRestarts({ stdout: (line) => output.push(line) }, [
    { workspaceId: "cc5c27ce-enabled", enabled: true },
    { workspaceId: "cc5c27ce-disabled", enabled: false },
  ]);
  expect(output).toEqual([
    "Workspace cc5c27ce-disabled is stopped and was not restarted; run 'coforge-computer start' to bring it online.",
  ]);
});

test("restart hint says nothing when every Workspace binding is enabled", () => {
  const output: string[] = [];
  reportSkippedRestarts({ stdout: (line) => output.push(line) }, [
    { workspaceId: "cc5c27ce-enabled", enabled: true },
  ]);
  expect(output).toEqual([]);
});

test("restart --supervisor dispatches to restartSupervisor instead of the ordinary restart", async () => {
  const calls: string[] = [];
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    daemon: {
      async start() {},
      async stop() {},
      async restart() {
        calls.push("restart");
      },
      async restartSupervisor() {
        calls.push("restartSupervisor");
      },
    },
  };

  expect(await runCli(["restart", "--supervisor"], dependencies)).toBe(0);
  expect(calls).toEqual(["restartSupervisor"]);

  expect(await runCli(["restart"], dependencies)).toBe(0);
  expect(calls).toEqual(["restartSupervisor", "restart"]);
});

test("restart --supervisor and --workspace are mutually exclusive", async () => {
  const stderr: string[] = [];
  const calls: string[] = [];
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    daemon: {
      async start() {},
      async stop() {},
      async restart() {
        calls.push("restart");
      },
      async restartSupervisor() {
        calls.push("restartSupervisor");
      },
    },
  };

  const exitCode = await runCli(["restart", "--supervisor", "--workspace", "a"], dependencies, {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
  });

  expect(exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(stderr.join("\n")).toContain("RESTART_CONFLICTING_TARGET");
});

test("restart --supervisor is unavailable without a wired dependency", async () => {
  const stderr: string[] = [];
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    daemon: {
      async start() {},
      async stop() {},
      async restart() {},
    },
  };

  const exitCode = await runCli(["restart", "--supervisor"], dependencies, {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
  });

  expect(exitCode).toBe(1);
  expect(stderr.join("\n")).toContain("Supervisor restart is unavailable in this build");
});

test("foreground runs the supervisor in the current process for external supervision", async () => {
  let calls = 0;
  const exitCode = await runCli(["foreground"], {
    login: { async run() {} },
    setup: { async run() {} },
    foreground: {
      async run() {
        calls += 1;
      },
    },
  });

  expect(exitCode).toBe(0);
  expect(calls).toBe(1);
});

test("status is registered, read-only, and forwards --json without touching lifecycle commands", async () => {
  const calls: Array<{ json: boolean }> = [];
  const lifecycleCalls: string[] = [];
  const status: StatusCommand = {
    async run(options) {
      calls.push(options);
    },
  };
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    status,
    daemon: {
      async start() {
        lifecycleCalls.push("start");
      },
      async stop() {
        lifecycleCalls.push("stop");
      },
      async restart() {
        lifecycleCalls.push("restart");
      },
    },
    updater: {
      resolveVersion: async () => {
        throw new Error("must not be called by status");
      },
      getCurrentVersion: async () => {
        throw new Error("must not be called by status");
      },
      install: async () => {
        throw new Error("must not be called by status");
      },
      upgrade: async () => {
        throw new Error("must not be called by status");
      },
      repair: async () => {
        throw new Error("must not be called by status");
      },
    },
  };

  expect(await runCli(["status"], dependencies)).toBe(0);
  expect(await runCli(["status", "--json"], dependencies)).toBe(0);

  expect(calls).toEqual([{ json: false }, { json: true }]);
  expect(lifecycleCalls).toEqual([]);
});

test("status is unavailable without a wired dependency", async () => {
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["status"],
    { login: { async run() {} }, setup: { async run() {} } },
    {
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    },
  );

  expect(exitCode).toBe(1);
  expect(stderr.join("\n")).toContain("Status is unavailable in this build");
});

test("a status failure that cannot even read the install reports exit code 1, human and JSON", async () => {
  const status: StatusCommand = {
    async run() {
      throw new CliError(
        "STATUS_INSTALL_UNREADABLE",
        "active.json is not valid JSON",
        "Reinstall CoForge Computer.",
      );
    },
  };
  const dependencies = { login: { async run() {} }, setup: { async run() {} }, status };

  const stderr: string[] = [];
  const humanExitCode = await runCli(["status"], dependencies, {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
  });
  expect(humanExitCode).toBe(1);
  expect(stderr.join("\n")).toContain("STATUS_INSTALL_UNREADABLE");
  expect(stderr.join("\n")).toContain("Next:");

  const stdout: string[] = [];
  const jsonExitCode = await runCli(["status", "--json"], dependencies, {
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
  });
  expect(jsonExitCode).toBe(1);
  expect(JSON.parse(stdout[0]!)).toEqual({
    ok: false,
    error: {
      code: "STATUS_INSTALL_UNREADABLE",
      message: "active.json is not valid JSON",
      hint: "Reinstall CoForge Computer.",
    },
  });
});

test("upgrade and install pass --allow-downgrade to the updater only when it is given", async () => {
  const calls: Array<{ operation: string; version: string; allowDowngrade: boolean }> = [];
  const updater = {
    async resolveVersion(selector: string) {
      return selector;
    },
    async getCurrentVersion() {
      return "1.0.17";
    },
    async install(version: string, options: { allowDowngrade: boolean }) {
      calls.push({ operation: "install", version, allowDowngrade: options.allowDowngrade });
    },
    async upgrade(version: string, options: { allowDowngrade: boolean }) {
      calls.push({ operation: "upgrade", version, allowDowngrade: options.allowDowngrade });
    },
    async repair() {
      return 0;
    },
  };
  const dependencies = { login: { async run() {} }, setup: { async run() {} }, updater };
  const io = { stdout: () => {}, stderr: () => {}, prompt: () => "y" };

  await runCli(["upgrade", "--version", "1.0.16", "--allow-downgrade"], dependencies, io);
  await runCli(["upgrade", "--version", "1.0.16"], dependencies, io);
  await runCli(["install", "--version", "1.0.16", "--allow-downgrade"], dependencies, io);
  await runCli(["install", "--version", "1.0.16"], dependencies, io);

  expect(calls).toEqual([
    { operation: "upgrade", version: "1.0.16", allowDowngrade: true },
    { operation: "upgrade", version: "1.0.16", allowDowngrade: false },
    { operation: "install", version: "1.0.16", allowDowngrade: true },
    { operation: "install", version: "1.0.16", allowDowngrade: false },
  ]);
});

test("the host command passes its flags to the host process", async () => {
  const calls: unknown[] = [];
  const host: HostCommand = {
    async run(options) {
      calls.push(options);
    },
  };
  const code = await runCli(
    [
      "host",
      "--server-url",
      "https://server.example",
      "--token",
      "chn_token",
      "--node-key",
      "machine-1",
      "--name",
      "lab-host",
      "--image",
      "coforge-computer:local",
    ],
    {
      login: { async run() {} },
      setup: { async run() {} },
      host,
    },
  );
  expect(code).toBe(0);
  expect(calls).toEqual([
    {
      serverUrl: "https://server.example",
      token: "chn_token",
      nodeKey: "machine-1",
      name: "lab-host",
      image: "coforge-computer:local",
      pollIntervalMs: 5000,
    },
  ]);
});
