import { expect, test } from "bun:test";
import { WindowsUserDaemonHost, windowsDaemonTaskXml } from "@lrm/coforge-daemon";
import { acceptingConnect } from "./accepting-connect";
import { recordingRegistrar } from "./recording-registrar";
import { rejection } from "./rejection";

const config = {
  workspaceId: "w",
  computerId: "computer",
  workspaceRoot: "/w",
  daemonApiKey: "secret",
};
const task = ["schtasks.exe"];
const query = [...task, "/Query", "/TN", "CoForge Daemon"];
const run = [...task, "/Run", "/TN", "CoForge Daemon"];
const end = [...task, "/End", "/TN", "CoForge Daemon"];

/** Exit codes by schtasks verb; verbs not listed exit 0. */
function schtasks(
  exits: Partial<Record<"/Query" | "/Run" | "/End", number>>,
  commands: string[][],
) {
  return async (command: string[]) => {
    commands.push(command);
    return exits[command[1] as "/Query" | "/Run" | "/End"] ?? 0;
  };
}

const options = {
  executablePath: "C:\\Coforge\\coforge-computer.exe",
  socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
  userId: "DESKTOP\\alice",
  timeoutMilliseconds: 20,
};

test("a registered task is run with schtasks /Run, never created or registered again", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar,
    run: schtasks({ "/Run": 1 }, commands),
  });
  await expect(host.ensureStarted(config)).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(registrar.calls).toBe(0);
  expect(commands).toEqual([query, run]);
});

test("an unregistered task is registered and started once through the registrar", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const host = new WindowsUserDaemonHost({
    ...options,
    connect: acceptingConnect("https://coforge.test"),
    serverUrl: "https://coforge.test",
    registrar,
    run: schtasks({ "/Query": 1 }, commands),
  });
  await host.ensureRunning();
  expect(registrar.calls).toBe(1);
  expect(commands).toEqual([query]);
});

test("ensureStarted falls back to a live local supervisor when the task cannot be registered", async () => {
  const commands: string[][] = [];
  const registrationFailed = new Error("coforge-installer: no installer for this target");
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar: recordingRegistrar(registrationFailed),
    run: schtasks({ "/Query": 1 }, commands),
  });
  const error = await host.ensureStarted(config).catch((thrown: unknown) => thrown as Error);
  expect((error as Error).message).toContain(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect((error as Error).cause).toBe(registrationFailed);
  expect(commands).toEqual([query]);
});

test("Windows ensureRunning reports a registration failure before waiting for a socket", async () => {
  const registrationFailed = new Error("coforge-installer: another upgrade is running");
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar: recordingRegistrar(registrationFailed),
    run: schtasks({ "/Query": 1 }, []),
  });
  const error = await host.ensureRunning().catch((thrown: unknown) => thrown as Error);
  expect((error as Error).message).toContain(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect((error as Error).cause).toBe(registrationFailed);
});

test("Windows ensureRunning reports a task that will not run", async () => {
  const commands: string[][] = [];
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar: recordingRegistrar(),
    run: schtasks({ "/Run": 1 }, commands),
  });
  await expect(host.ensureRunning()).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(commands).toEqual([query, run]);
});

test("restart ends then runs the registered scheduled task", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar,
    // Fail /Run so this exercises only the command sequence, not the local handshake.
    run: schtasks({ "/Run": 1 }, commands),
  });
  await expect(host.restart()).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(registrar.calls).toBe(0);
  expect(commands).toEqual([end, query, run]);
});

test("restart of an unregistered task asks the registrar after /End", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const host = new WindowsUserDaemonHost({
    ...options,
    connect: acceptingConnect("https://coforge.test"),
    serverUrl: "https://coforge.test",
    registrar,
    run: schtasks({ "/Query": 1 }, commands),
  });
  await host.restart();
  expect(registrar.calls).toBe(1);
  expect(commands).toEqual([end, query]);
});

test("assertRestartable refuses a task Task Scheduler does not know, without registering anything", async () => {
  const commands: string[][] = [];
  const registrar = recordingRegistrar();
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar,
    run: schtasks({ "/Query": 1 }, commands),
  });

  const error = await rejection(host.assertRestartable());

  expect(error.message).toContain("CoForge Daemon");
  expect(registrar.calls).toBe(0);
  expect(commands).toEqual([query]);
});

test("assertRestartable resolves for a registered task", async () => {
  const commands: string[][] = [];
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar: recordingRegistrar(),
    run: schtasks({}, commands),
  });

  await expect(host.assertRestartable()).resolves.toBeUndefined();
  expect(commands).toEqual([query]);
});

test("restart ignores /End's own exit code (the task may already be stopped)", async () => {
  const commands: string[][] = [];
  const host = new WindowsUserDaemonHost({
    ...options,
    registrar: recordingRegistrar(),
    run: schtasks({ "/End": 1, "/Run": 1 }, commands),
  });
  await expect(host.restart()).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(commands).toEqual([end, query, run]);
});

test("the Windows service definition is the task XML rendered from the host's own inputs", () => {
  const input = {
    userId: "DESKTOP\\alice",
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    stateDirectory: "C:\\Users\\alice\\.coforge\\daemon",
    daemonConnectionEndpoint: "wss://coforge.test/connection/websocket",
  };
  const host = new WindowsUserDaemonHost({ ...input, registrar: recordingRegistrar() });

  expect(host.serviceDefinition()).toEqual({
    manager: "windows-task",
    contents: windowsDaemonTaskXml(input),
  });
});
