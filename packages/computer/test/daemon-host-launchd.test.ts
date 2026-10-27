import { expect, test } from "bun:test";
import { acceptingConnect } from "./accepting-connect";
import { recordingRegistrar } from "./recording-registrar";
import { LaunchdDaemonHost, launchdPlist } from "@lrm/coforge-daemon";

const target = "gui/501/cn.coforge.computer.daemon";

test("launchd service dispatches the daemon through the unified executable", () => {
  const plist = launchdPlist({
    label: "cn.coforge.computer.daemon",
    executablePath: "/Users/alice/.coforge/computer/install/active/coforge-computer",
    socketPath: "/Users/alice/.coforge/daemon/daemon.sock",
  });

  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain(
    "<array><string>/Users/alice/.coforge/computer/install/active/coforge-computer</string><string>__daemon</string><string>--socket</string>",
  );
  expect(plist).not.toContain("alice-secret");
});

test("an unregistered label is registered through the registrar, once, and the host writes nothing", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  let registered = false;
  const service = new LaunchdDaemonHost({
    serverUrl: "https://coforge.test",
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-daemon",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    registrar: {
      async registerAndStart() {
        registered = true;
        await registrar.registerAndStart();
      },
    },
    connect: acceptingConnect("https://coforge.test"),
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: registered ? 0 : 1, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.ensureRunning();
  await service.ensureRunning();
  expect(registrar.calls).toBe(1);
  expect(commands).toEqual([
    ["launchctl", "print", target],
    ["launchctl", "print", target],
  ]);
});

test("a loaded label is neither registered nor restarted by ensureRunning", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const service = new LaunchdDaemonHost({
    serverUrl: "https://coforge.test",
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    registrar,
    connect: acceptingConnect("https://coforge.test"),
    run: async (command) => {
      commands.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  await service.ensureRunning();
  expect(registrar.calls).toBe(0);
  expect(commands).toEqual([["launchctl", "print", target]]);
});

test("ensureRunning fails with the registrar's own error when the label cannot be registered", async () => {
  const commands: string[][] = [];
  const registrationFailed = new Error("registration failed for test");
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    registrar: recordingRegistrar(registrationFailed),
    run: async (command) => {
      commands.push(command);
      return { code: 1, stdout: "", stderr: "" };
    },
  });

  await expect(service.ensureRunning()).rejects.toBe(registrationFailed);
  expect(commands).toEqual([["launchctl", "print", target]]);
});

test("launchd stop accepts an absent process but preserves permission errors with their diagnostic", async () => {
  let exitCode = 3;
  let stderr = "";
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async () => ({ code: exitCode, stdout: "", stderr }),
  });
  await service.stop();
  exitCode = 13;
  stderr = "Permission denied\n";
  await expect(service.stop()).rejects.toThrow("launchctl bootout failed (13): Permission denied");
});

test("REGRESSION: stop does not return until the label actually leaves launchd after bootout", async () => {
  // Reproduces the dev.34→dev.35 incident: `bootout` returns immediately, but launchd keeps
  // answering `print` with the outgoing instance for a few seconds while it runs its own
  // SIGTERM/SIGKILL teardown ladder. `stop()` must poll a fresh `print` rather than trusting
  // `bootout`'s return.
  const printCalls: number[] = [];
  const disappearsAfter = 3;
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    sleep: async () => {},
    run: async (command) => {
      if (command[1] === "bootout") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "print") {
        printCalls.push(1);
        return { code: printCalls.length <= disappearsAfter ? 0 : 1, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.stop();
  expect(printCalls).toHaveLength(disappearsAfter + 1);
});

test("stop returns immediately when the label is already absent", async () => {
  const commands: string[][] = [];
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async (command) => {
      commands.push(command);
      return { code: 3, stdout: "", stderr: "" };
    },
  });

  await service.stop();
  expect(commands).toEqual([["launchctl", "bootout", target]]);
});

test("stop times out with a clear error when the old job never leaves launchd", async () => {
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    stopTimeoutMilliseconds: 0,
    sleep: async () => {},
    run: async (command) => {
      if (command[1] === "bootout") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "print") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await expect(service.stop()).rejects.toThrow("did not leave launchd");
});

test("REGRESSION: restart on a loaded label issues exactly kickstart -k, never bootout or bootstrap", async () => {
  const commands: string[][] = [];
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    serverUrl: "https://coforge.test",
    connect: acceptingConnect("https://coforge.test"),
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "kickstart") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.restart();
  expect(commands).toEqual([
    ["launchctl", "print", target],
    ["launchctl", "kickstart", "-k", target],
  ]);
});

test("restart of an unregistered label asks the registrar and issues no launchctl change", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  let registered = false;
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    serverUrl: "https://coforge.test",
    connect: acceptingConnect("https://coforge.test"),
    registrar: {
      async registerAndStart() {
        registered = true;
        await registrar.registerAndStart();
      },
    },
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return { code: registered ? 0 : 1, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await service.restart();
  expect(registrar.calls).toBe(1);
  expect(commands).toEqual([["launchctl", "print", target]]);
});

test("restart of an unregistered label fails with the registrar's error", async () => {
  const registrationFailed = new Error("coforge-installer: another upgrade is running");
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    registrar: recordingRegistrar(registrationFailed),
    run: async (command) => {
      if (command[1] === "print") return { code: 1, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await expect(service.restart()).rejects.toBe(registrationFailed);
});

test("assertRestartable throws with the launchctl diagnostic when the label is not loaded", async () => {
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async () => ({
      code: 113,
      stdout: "",
      stderr: 'Could not find service "cn.coforge.computer.daemon" in domain for port\n',
    }),
  });

  await expect(service.assertRestartable()).rejects.toThrow(
    'launchctl print failed (113): Could not find service "cn.coforge.computer.daemon" in domain for port',
  );
});

test("assertRestartable resolves when the label is loaded", async () => {
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });

  await expect(service.assertRestartable()).resolves.toBeUndefined();
});

test("a failed launchctl command carries its stderr diagnostic in the thrown error", async () => {
  const service = new LaunchdDaemonHost({
    registrar: recordingRegistrar(),
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async (command) => {
      if (command[1] === "print") return { code: 0, stdout: "", stderr: "" };
      if (command[1] === "kickstart")
        return {
          code: 113,
          stdout: "",
          stderr: 'Could not find service "cn.coforge.computer.daemon" in domain for port\n',
        };
      throw new Error(`unexpected command ${command.join(" ")}`);
    },
  });

  await expect(service.restart()).rejects.toThrow(
    'launchctl kickstart failed (113): Could not find service "cn.coforge.computer.daemon" in domain for port',
  );
});

test("the launchd service definition is the plist rendered from the host's own inputs", () => {
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    stateDirectory: "/state",
    daemonConnectionEndpoint: "wss://coforge.test/connection/websocket",
    homeDirectory: "/Users/alice",
    uid: 501,
    registrar: recordingRegistrar(),
  });

  expect(service.serviceDefinition()).toEqual({
    manager: "launchd",
    contents: launchdPlist({
      label: "cn.coforge.computer.daemon",
      executablePath: "/install/coforge-computer",
      socketPath: "/state/daemon.sock",
      stateDirectory: "/state",
      daemonConnectionEndpoint: "wss://coforge.test/connection/websocket",
    }),
    path: "/Users/alice/Library/LaunchAgents/cn.coforge.computer.daemon.plist",
  });
});
