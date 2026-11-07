import { expect, test } from "bun:test";
import { DaemonCommandRejectedError, type DaemonCommandRunner } from "@lrm/coforge-daemon";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";
import { createCommand, createComputerUpgradeAdmission } from "#src/daemon-client/index";
import { CliError } from "#src/errors";

const output = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

test("scoped stop and restart dispatch to supervisor without stopping the machine", async () => {
  const calls: string[] = [];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async (operation, workspaceId) => {
        calls.push(`${operation}:${workspaceId}`);
        return [];
      },
    },
  });
  await command.stop("workspace-a");
  await command.restart("workspace-a");
  expect(calls).toEqual(["stop:workspace-a", "restart:workspace-a"]);
});

test("Computer commands delegate machine-wide lifecycle to the resident supervisor", async () => {
  const calls: string[] = [];
  const daemon: DaemonCommandRunner & { stop(): Promise<void> } = {
    ensureRunning: async () => {
      calls.push("ensure-running");
    },
    isRunning: async () => true,
    command: async (operation) => {
      calls.push(operation);
      return [];
    },
    stop: async () => {
      calls.push("process-stop");
    },
  };
  const command = createCommand({ daemon });

  await command.start();
  await command.stop();
  await command.restart();

  expect(calls).toEqual([
    "ensure-running",
    "start",
    "ensure-running",
    "stop",
    "ensure-running",
    "restart",
  ]);
});

test("start and restart announce their progress so the terminal is not silent", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [],
    },
    write: progress.write,
  });
  await command.start();
  await command.restart();
  expect(progress.lines).toEqual([
    "Starting CoForge...",
    "CoForge Computer is online.",
    "Restarting CoForge...",
    "CoForge Computer is back online.",
  ]);
});

test("scoped restart reports which Workspace runtime the command acted on", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [
        {
          workspaceId: "ws-a",
          computerId: "c",
          enabled: true,
          processId: 42,
          instanceId: "i",
          version: "1",
        },
      ],
    },
    resolveWorkspace: async () => ({ id: "ws-a", slug: "workspace-slug" }),
    write: progress.write,
  });
  await command.restart("workspace-slug");
  expect(progress.lines).toEqual([
    "Restarting Workspace workspace-slug...",
    "Workspace workspace-slug restarted and is back online.",
  ]);
});

test("stop stays silent like before; lifecycle output is opt-in through the writer", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [],
    },
    write: progress.write,
  });
  await command.stop();
  expect(progress.lines).toEqual([]);
});

test("commands still work without a writer wired (tests, internal callers)", async () => {
  const calls: string[] = [];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async (operation) => {
        calls.push(operation);
        return [];
      },
    },
  });
  await command.start();
  await command.restart();
  expect(calls).toEqual(["start", "restart"]);
});

test("restart resolves with the daemon's post-command runtime snapshot", async () => {
  const runtimes = [
    {
      workspaceId: "a",
      computerId: "c",
      enabled: true,
      processId: 1,
      instanceId: "i",
      version: "v",
    },
    {
      workspaceId: "b",
      computerId: "c",
      enabled: false,
      processId: 0,
      instanceId: "",
      version: "",
    },
  ];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => runtimes,
    },
  });
  await expect(command.restart()).resolves.toEqual(runtimes);
});

test("restart waits for the supervisor's completed replacement response", async () => {
  const stopping = Promise.withResolvers<void>();
  const stopCalled = Promise.withResolvers<void>();
  const calls: string[] = [];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async (operation) => {
        stopCalled.resolve();
        await stopping.promise;
        calls.push(operation);
        return [];
      },
    },
  });
  const restarting = command.restart();
  try {
    await stopCalled.promise;
    expect(calls).toEqual([]);
  } finally {
    stopping.resolve();
    await restarting;
  }
  // No unconditional start: the supervisor preserves stopped bindings on global restart.
  expect(calls).toEqual(["restart"]);
});

test("starting a Workspace the cloud removed this Computer from names the setup command that attaches it again", async () => {
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => {
        throw new DaemonCommandRejectedError(
          "start",
          "Workspace ws-a is parked",
          "computer_unlinked",
        );
      },
    },
    resolveWorkspace: async () => ({ id: "ws-a", slug: "acme" }),
  });

  const failure = await command.start("acme").catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toMatchObject({
    code: "COMPUTER_UNLINKED",
    message:
      "This Computer was removed from Workspace acme in CoForge (computer_unlinked). This Computer stopped connecting to it and stopped its Agents; local files are kept.",
    hint: "Run 'coforge-computer detach --workspace acme' to remove the stale binding, then 'coforge-computer setup --workspace acme' to attach it again.",
  });
});

test("an unscoped restart refused for a deleted Workspace names that Workspace and the commands that move on", async () => {
  const resolved: string[] = [];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => {
        throw new DaemonCommandRejectedError(
          "restart",
          "Workspace ws-gone was deleted in CoForge (workspace_deleted).",
          "workspace_deleted",
          "ws-gone",
        );
      },
    },
    resolveWorkspace: async (selector) => {
      resolved.push(selector);
      return { id: "ws-gone", slug: "old-team" };
    },
  });

  const failure = await command.restart().catch((error: unknown) => error);

  expect(resolved).toEqual(["ws-gone"]);
  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toMatchObject({
    code: "WORKSPACE_DELETED",
    message:
      "Workspace ws-gone was deleted in CoForge (workspace_deleted). This Computer stopped connecting to it and stopped its Agents; local files are kept.",
    hint: "Run 'coforge-computer setup --workspace <workspace-slug>' to attach this Computer to another Workspace, or 'coforge-computer stop --workspace old-team' to stop this binding.",
  });
});

const runtime = (workspaceId: string, extra: object) => ({
  workspaceId,
  computerId: "c",
  enabled: true,
  processId: 7,
  instanceId: "i",
  version: "v",
  ...extra,
});

test("start names each Workspace still under way, and fails naming the restart for one that did not connect", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [
        runtime("ws-a", { cloudConnection: "connected" }),
        runtime("ws-b", { lifecycleUnderWay: true }),
        runtime("ws-c", {
          cloudConnection: "not_connected",
          cloudConnectionError: "transport closed (2)",
        }),
        runtime("ws-d", {}),
      ],
    },
    resolveWorkspace: async (selector) => ({ id: selector, slug: `slug-${selector}` }),
    write: progress.write,
  });

  const failure = await command.start().catch((error: unknown) => error);

  expect(progress.lines).toEqual([
    "Starting CoForge...",
    "CoForge Computer started, but not every Workspace is connected yet:",
    "  slug-ws-b: still starting. Run 'coforge-computer status' to follow it.",
    "  slug-ws-c: not connected (transport closed (2)).",
  ]);
  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toMatchObject({
    code: "WORKSPACE_NOT_CONNECTED",
    message: "Workspace slug-ws-c did not connect to CoForge.",
    hint: "Run 'coforge-computer restart --workspace slug-ws-c' to try again, or 'coforge-computer status' to check it.",
  });
});

test("a restart still under way at its deadline says so and succeeds", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [runtime("ws-a", { lifecycleUnderWay: true })],
    },
    resolveWorkspace: async (selector) => ({ id: selector, slug: `slug-${selector}` }),
    write: progress.write,
  });

  await command.restart("ws-a");

  expect(progress.lines).toEqual([
    "Restarting Workspace ws-a...",
    "Workspace ws-a restarted, but is not connected yet:",
    "  slug-ws-a: still restarting. Run 'coforge-computer status' to follow it.",
  ]);
});

test("a Workspace still connecting says why its latest attempt failed", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [
        runtime("ws-a", {
          cloudConnection: "connecting",
          cloudConnectionError: "connect error 100: internal server error",
        }),
      ],
    },
    resolveWorkspace: async (selector) => ({ id: selector, slug: `slug-${selector}` }),
    write: progress.write,
  });

  await command.start();

  expect(progress.lines).toEqual([
    "Starting CoForge...",
    "CoForge Computer started, but not every Workspace is connected yet:",
    "  slug-ws-a: still connecting, retrying after connect error 100: internal server error. Run 'coforge-computer status' to follow it.",
  ]);
});

test("a restart naming several Workspaces that did not connect gives the command for each", async () => {
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [
        runtime("ws-a", { cloudConnection: "not_connected", cloudConnectionError: "x" }),
        runtime("ws-b", { cloudConnection: "not_connected", cloudConnectionError: "y" }),
      ],
    },
    resolveWorkspace: async (selector) => ({ id: selector, slug: `slug-${selector}` }),
  });

  await expect(command.restart()).rejects.toMatchObject({
    code: "WORKSPACE_NOT_CONNECTED",
    message: "Workspaces slug-ws-a, slug-ws-b did not connect to CoForge.",
    hint: "Run 'coforge-computer restart --workspace slug-ws-a' and 'coforge-computer restart --workspace slug-ws-b' to try again, or 'coforge-computer status' to check them.",
  });
});

test("a stop that answers before a Workspace has stopped names it with the command to follow it", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [
        runtime("ws-a", { enabled: false, processId: 0 }),
        runtime("ws-b", { enabled: true, processId: 9 }),
      ],
    },
    resolveWorkspace: async (selector) => ({ id: selector, slug: `slug-${selector}` }),
    write: progress.write,
  });

  await command.stop();

  expect(progress.lines).toEqual([
    "CoForge Computer stop requested, but not every Workspace has stopped yet:",
    "  slug-ws-b: still stopping. Run 'coforge-computer status' to follow it.",
  ]);
});

test("a scoped stop only reports its own Workspace", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [
        runtime("ws-a", { enabled: false, processId: 0 }),
        runtime("ws-b", { enabled: true, processId: 9 }),
      ],
    },
    resolveWorkspace: async (selector) => ({ id: selector, slug: selector }),
    write: progress.write,
  });

  await command.stop("ws-a");

  expect(progress.lines).toEqual([]);
});

test("a scoped start reports only its own Workspace, not another one's restart under way", async () => {
  const progress = output();
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [
        runtime("ws-a", { cloudConnection: "connected" }),
        runtime("ws-b", { lifecycleUnderWay: true }),
      ],
    },
    resolveWorkspace: async (selector) => ({ id: selector, slug: selector }),
    write: progress.write,
  });

  await command.start("ws-a");

  expect(progress.lines).toEqual(["Starting CoForge...", "CoForge Computer is online."]);
});

test("Linux start warns about logind session cleanup once", async () => {
  const progress = output();
  let detections = 0;
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      isRunning: async () => true,
      command: async () => [],
    },
    write: progress.write,
    logindRisk: async () => {
      detections++;
      return { sessionScope: "session-7.scope", user: "alice", linger: false };
    },
  });
  await command.start();
  await command.start();
  expect(detections).toBe(1);
  expect(progress.lines.filter((line) => line.startsWith("Warning:"))).toHaveLength(1);
});

test("computer upgrade admission asks a running Daemon and reports true when it launched", async () => {
  const calls: string[] = [];
  const admit = createComputerUpgradeAdmission({
    ensureRunning: async () => {
      calls.push("ensure-running");
    },
    isRunning: async () => {
      calls.push("is-running");
      return true;
    },
    command: async () => [],
    computerUpgrade: async (requestId, expectedVersion) => {
      calls.push(`computer-upgrade:${requestId}:${expectedVersion}`);
      return [];
    },
  });
  expect(await admit("req-1", "0.1.19")).toBe(true);
  expect(calls).toEqual(["is-running", "computer-upgrade:req-1:0.1.19"]);
});

test("a deliberately stopped Daemon is never started to ask it; the job launches directly", async () => {
  const admit = createComputerUpgradeAdmission({
    ensureRunning: async () => {
      throw new Error("admission must not start the Daemon");
    },
    isRunning: async () => false,
    command: async () => [],
    computerUpgrade: async () => {
      throw new Error("a stopped Daemon cannot be asked");
    },
  });
  expect(await admit("req-stopped", "0.1.19")).toBe(false);
});

test("an unanswered isRunning probe falls back to launching directly", async () => {
  const admit = createComputerUpgradeAdmission({
    ensureRunning: async () => {},
    isRunning: async () => {
      throw new Error("socket probe failed");
    },
    command: async () => [],
    computerUpgrade: async () => [],
  });
  expect(await admit("req-probe", "0.1.19")).toBe(false);
});

test("computer upgrade admission names the pending operation instead of a raw code", async () => {
  const admit = createComputerUpgradeAdmission({
    ensureRunning: async () => {},
    isRunning: async () => true,
    command: async () => [],
    computerUpgrade: async () => {
      throw new DaemonCommandRejectedError(
        "daemon:computer_upgrade",
        "upgrade is still pending",
        UPGRADE_ERROR_CODE.OPERATION_PENDING,
        "pending-workspace",
      );
    },
  });
  await expect(admit("req-2", "0.1.19")).rejects.toThrow(
    "A Computer upgrade is already in progress on this machine",
  );
});

test("a Daemon that predates daemon:computer_upgrade falls back to launching directly", async () => {
  // The wire shape every pre-#685 Daemon produces for an unknown lifecycle method: accepted
  // false, the refusal text, and no reason code — the protocol has no capability field, so a
  // codeless refusal is the only signal this Daemon cannot admit the request.
  const admit = createComputerUpgradeAdmission({
    ensureRunning: async () => {},
    isRunning: async () => true,
    command: async () => [],
    computerUpgrade: async () => {
      throw new DaemonCommandRejectedError(
        "daemon:computer_upgrade",
        "unknown lifecycle operation",
      );
    },
  });
  expect(await admit("req-3", "0.1.19")).toBe(false);
});

test("a Daemon without computer upgrade support falls back to launching directly", async () => {
  const admit = createComputerUpgradeAdmission({
    ensureRunning: async () => {},
    isRunning: async () => true,
    command: async () => [],
  });
  expect(await admit("req-4", "0.1.19")).toBe(false);
});

test("an unexpected computer upgrade refusal propagates unchanged", async () => {
  const admit = createComputerUpgradeAdmission({
    ensureRunning: async () => {},
    isRunning: async () => true,
    command: async () => [],
    computerUpgrade: async () => {
      throw new DaemonCommandRejectedError(
        "daemon:computer_upgrade",
        "state directory is gone",
        UPGRADE_ERROR_CODE.UPDATE_DOWNLOAD_FAILED,
      );
    },
  });
  await expect(admit("req-5", "0.1.19")).rejects.toThrow("state directory is gone");
});
