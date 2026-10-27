import { expect, test } from "bun:test";
import { acceptingConnect } from "./accepting-connect";
import { recordingRegistrar } from "./recording-registrar";
import { rejection } from "./rejection";
import { systemdUserUnit, SystemdUserDaemonHost } from "@lrm/coforge-daemon";

const ok = { code: 0, stdout: "", stderr: "" };
const failed = (stderr: string, code = 1) => ({ code, stdout: "", stderr });
const show = ["systemctl", "--user", "show", "--property=LoadState", "--value"];
const loadState = (state: string) => ({ code: 0, stdout: `${state}\n`, stderr: "" });
const isLoadStateQuery = (command: string[]) => command[2] === "show";

test("systemd user unit dispatches the daemon through the unified executable", () => {
  const unit = systemdUserUnit(
    "/home/alice/.local/share/coforge/active/coforge-computer",
    "/run/user/501/coforge/daemon.sock",
  );
  expect(unit).toContain("WantedBy=default.target");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("KillMode=mixed");
  expect(unit).toContain(
    "ExecStart=/home/alice/.local/share/coforge/active/coforge-computer __daemon --socket /run/user/501/coforge/daemon.sock",
  );
});

test("a registered unit is started through systemd without the registrar or any unit write", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const service = new SystemdUserDaemonHost({
    serverUrl: "https://coforge.test",
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    registrar,
    run: async (command) => {
      commands.push(command);
      if (isLoadStateQuery(command)) return loadState("loaded");
      return failed("Job for coforge-daemon.service failed.");
    },
  });
  await expect(
    service.ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      daemonApiKey: "secret",
    }),
  ).rejects.toThrow("`systemctl --user start coforge-daemon.service` failed (1)");
  expect(registrar.calls).toBe(0);
  expect(commands).toEqual([
    [...show, "coforge-daemon.service"],
    ["systemctl", "--user", "start", "coforge-daemon.service"],
  ]);
});

test("an unregistered unit is registered and started once through the registrar, writing nothing", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const service = new SystemdUserDaemonHost({
    serverUrl: "https://coforge.test",
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    connect: acceptingConnect("https://coforge.test"),
    registrar,
    run: async (command) => {
      commands.push(command);
      if (isLoadStateQuery(command)) return loadState("not-found");
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.ensureRunning();
  expect(registrar.calls).toBe(1);
  expect(commands).toEqual([[...show, "coforge-daemon.service"]]);
});

test("an unregistered unit fails with the registrar's own error", async () => {
  const registrationFailed = new Error("coforge-installer: another upgrade is running");
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/missing/daemon.sock",
    registrar: recordingRegistrar(registrationFailed),
    run: async (command) => (isLoadStateQuery(command) ? loadState("not-found") : ok),
  });
  await expect(service.ensureRunning()).rejects.toBe(registrationFailed);
});

test("a failed start repeats systemd's own reason and names the unit to inspect", async () => {
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/missing/daemon.sock",
    registrar: recordingRegistrar(),
    run: async () =>
      failed("Job for coforge-daemon.service failed because the control process exited.", 3),
  });
  const error = await rejection(service.ensureRunning());
  expect(error.message).toContain("`systemctl --user start coforge-daemon.service` failed (3)");
  expect(error.message).toContain("the control process exited");
  expect(error.message).toContain("systemctl --user status coforge-daemon.service");
});

test("a shell with no systemd user session says so and gives the commands that open one", async () => {
  const registrar = recordingRegistrar();
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/missing/daemon.sock",
    registrar,
    run: async () => failed("Failed to connect to bus: No medium found"),
  });
  const error = await rejection(service.ensureRunning());
  expect(error.message).toContain("Failed to connect to bus: No medium found");
  expect(error.message).toContain("no systemd user session");
  expect(error.message).toContain("su");
  expect(error.message).toContain("machinectl shell");
  expect(registrar.calls).toBe(0);
});

test("stopping a Daemon that has no user service installed says how to install one", async () => {
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/missing/daemon.sock",
    registrar: recordingRegistrar(),
    run: async () =>
      failed("Failed to stop coforge-daemon.service: Unit coforge-daemon.service not loaded.", 5),
  });
  const error = await rejection(service.stop());
  expect(error.message).toContain("`systemctl --user stop coforge-daemon.service` failed (5)");
  expect(error.message).toContain("not loaded");
  expect(error.message).toContain("coforge-computer start");
});

test("start uses systemd rather than launching an unmanaged process", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/missing/coforge-computer",
    socketPath: "/missing/daemon.sock",
    registrar: recordingRegistrar(),
    run: async (command) => {
      commands.push(command);
      return failed("Failed to connect to bus: No medium found");
    },
  });
  await expect(service.ensureRunning()).rejects.toThrow(
    "`systemctl --user start coforge-daemon.service` failed (1)",
  );
  expect(commands).toEqual([
    [...show, "coforge-daemon.service"],
    ["systemctl", "--user", "start", "coforge-daemon.service"],
  ]);
});

test("restart resets any failed-state latch before restarting the registered systemd user service", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    registrar,
    run: async (command) => {
      commands.push(command);
      if (isLoadStateQuery(command)) return loadState("loaded");
      // Fails the restart step deliberately so this exercises only the command sequence and
      // error handling, not the local-handshake wait a real success would go on to do.
      return command.includes("restart") ? failed("Job for coforge-daemon.service failed.") : ok;
    },
  });
  await expect(service.restart()).rejects.toThrow(
    "`systemctl --user restart coforge-daemon.service` failed (1)",
  );
  expect(registrar.calls).toBe(0);
  expect(commands).toEqual([
    [...show, "coforge-daemon.service"],
    ["systemctl", "--user", "reset-failed", "coforge-daemon.service"],
    ["systemctl", "--user", "restart", "coforge-daemon.service"],
  ]);
});

test("restart ignores reset-failed's own exit code", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    registrar: recordingRegistrar(),
    run: async (command) => {
      commands.push(command);
      if (isLoadStateQuery(command)) return loadState("loaded");
      // reset-failed's own exit code (1: nothing to reset) must not fail the restart; the
      // restart step is also failed here only to avoid a real local-handshake wait.
      return failed("Job for coforge-daemon.service failed.");
    },
  });
  await expect(service.restart()).rejects.toThrow(
    "`systemctl --user restart coforge-daemon.service` failed (1)",
  );
  expect(commands).toEqual([
    [...show, "coforge-daemon.service"],
    ["systemctl", "--user", "reset-failed", "coforge-daemon.service"],
    ["systemctl", "--user", "restart", "coforge-daemon.service"],
  ]);
});

test("restart of an unregistered unit asks the registrar and changes nothing itself", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const service = new SystemdUserDaemonHost({
    serverUrl: "https://coforge.test",
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    connect: acceptingConnect("https://coforge.test"),
    registrar,
    run: async (command) => {
      commands.push(command);
      if (isLoadStateQuery(command)) return loadState("not-found");
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.restart();
  expect(registrar.calls).toBe(1);
  expect(commands).toEqual([[...show, "coforge-daemon.service"]]);
});

function systemdHostAnswering(
  state: ReturnType<typeof loadState> | ReturnType<typeof failed>,
  commands: string[][],
  registrar = recordingRegistrar(),
) {
  return new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    registrar,
    run: async (command) => {
      commands.push(command);
      return state;
    },
  });
}

test("assertRestartable refuses a unit systemd does not know, without registering anything", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const service = systemdHostAnswering(loadState("not-found"), commands, registrar);

  const error = await rejection(service.assertRestartable());

  expect(error.message).toContain("coforge-daemon.service");
  expect(error.message).toContain("not-found");
  expect(registrar.calls).toBe(0);
  expect(commands).toEqual([[...show, "coforge-daemon.service"]]);
});

test("assertRestartable resolves for a loaded unit", async () => {
  await expect(
    systemdHostAnswering(loadState("loaded"), []).assertRestartable(),
  ).resolves.toBeUndefined();
});

test("assertRestartable leaves a systemctl that cannot answer to the restart that follows", async () => {
  await expect(
    systemdHostAnswering(
      failed("Failed to connect to bus: No medium found"),
      [],
    ).assertRestartable(),
  ).resolves.toBeUndefined();
});

test("a validated injected service name isolates native lifecycle integration", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/tmp/coforge-native-test",
    executablePath: "/install/coforge-computer",
    socketPath: "/tmp/coforge-native-test/daemon.sock",
    serviceName: "coforge-native-test-a1b2.service",
    registrar: recordingRegistrar(),
    run: async (command) => {
      commands.push(command);
      if (isLoadStateQuery(command)) return loadState("loaded");
      return failed("Job failed.");
    },
  });
  await expect(service.ensureRunning()).rejects.toThrow(
    "`systemctl --user start coforge-native-test-a1b2.service` failed (1)",
  );
  expect(commands).toEqual([
    [...show, "coforge-native-test-a1b2.service"],
    ["systemctl", "--user", "start", "coforge-native-test-a1b2.service"],
  ]);
});

test("systemd host rejects unsafe injected service names", () => {
  expect(
    () =>
      new SystemdUserDaemonHost({
        homeDirectory: "/tmp/test",
        executablePath: "/install/coforge-computer",
        socketPath: "/tmp/test/daemon.sock",
        serviceName: "../coforge-daemon.service",
        registrar: recordingRegistrar(),
      }),
  ).toThrow("invalid systemd user service name");
});

test("the systemd service definition is the unit rendered from the host's own inputs", () => {
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    stateDirectory: "/state",
    daemonConnectionEndpoint: "wss://coforge.test/connection/websocket",
    registrar: recordingRegistrar(),
  });

  expect(service.serviceDefinition()).toEqual({
    manager: "systemd-user",
    contents: systemdUserUnit(
      "/install/coforge-computer",
      "/state/daemon.sock",
      "/state",
      "wss://coforge.test/connection/websocket",
    ),
    path: "/home/alice/.config/systemd/user/coforge-daemon.service",
  });
});
