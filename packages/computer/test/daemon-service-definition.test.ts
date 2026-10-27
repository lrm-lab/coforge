import { expect, test } from "bun:test";
import {
  launchdPlist,
  systemdUserUnit,
  windowsDaemonTaskXml,
  type DaemonServiceDefinition,
} from "@lrm/coforge-daemon";

import { runLifecycleCommand } from "#src/release/lifecycle-command";
import { LifecycleServiceDefinitionSchema } from "#src/release/installer-contract";
import { resolveServiceDefinition } from "#src/daemon-service/daemon-host";
import { SERVICE_MANAGER_BY_PLATFORM } from "./service-manager";

/*
 * The service definition the installer writes before it starts the supervisor service is rendered
 * here, by the Computer, from the same inputs and the same renderers its own daemon host uses.
 * These cases pin the inputs per platform; the host-side tests (daemon-host-*.test.ts) pin that the
 * text equals what the host writes.
 */

const SERVER_URL = "https://coforge.test";
const ENDPOINT = "wss://coforge.test/connection/websocket";

const MACHINES = {
  darwin: {
    platform: "darwin",
    homeDirectory: "/Users/example",
    uid: 501,
    environment: {},
    serverUrl: SERVER_URL,
  },
  linux: {
    platform: "linux",
    homeDirectory: "/home/example",
    uid: 1000,
    environment: {},
    serverUrl: SERVER_URL,
  },
  win32: {
    platform: "win32",
    homeDirectory: "C:\\Users\\example",
    uid: 0,
    environment: {},
    serverUrl: SERVER_URL,
    windowsUserId: "EXAMPLE\\alice",
  },
} as const;

test("macOS: the launchd plist runs the active executable with this user's state directory", () => {
  const definition = resolveServiceDefinition(MACHINES.darwin);

  expect(definition).toEqual({
    manager: "launchd",
    contents: launchdPlist({
      label: "cn.coforge.computer.daemon",
      executablePath: "/Users/example/.coforge/computer/install/active/coforge-computer",
      socketPath: "/Users/example/.coforge/daemon/daemon.sock",
      stateDirectory: "/Users/example/.coforge/daemon",
      daemonConnectionEndpoint: ENDPOINT,
    }),
  });
});

test("Linux: the systemd user unit runs the active executable with this user's state directory", () => {
  const definition = resolveServiceDefinition(MACHINES.linux);

  expect(definition).toEqual({
    manager: "systemd-user",
    contents: systemdUserUnit(
      "/home/example/.coforge/computer/install/active/coforge-computer",
      "/home/example/.coforge/daemon/daemon.sock",
      "/home/example/.coforge/daemon",
      ENDPOINT,
    ),
  });
});

test("Windows: the task XML is rendered for the signed-in user and the active executable", () => {
  const definition = resolveServiceDefinition(MACHINES.win32);

  expect(definition).toEqual({
    manager: "windows-task",
    contents: windowsDaemonTaskXml({
      userId: "EXAMPLE\\alice",
      executablePath:
        "C:\\Users\\example\\.coforge\\computer\\install\\active\\coforge-computer.exe",
      socketPath: "C:\\Users\\example\\.coforge\\daemon\\daemon.sock",
      stateDirectory: "C:\\Users\\example\\.coforge\\daemon",
      daemonConnectionEndpoint: ENDPOINT,
    }),
  });
});

test("the E2E executable and connection endpoint overrides apply only when E2E is allowed", () => {
  const overrides = {
    COFORGE_E2E_DAEMON_EXECUTABLE: "/e2e/bin/coforge-computer",
    COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT: "ws://127.0.0.1:9999/connection/websocket",
  };

  const allowed = resolveServiceDefinition({
    ...MACHINES.darwin,
    environment: { ...overrides, COFORGE_E2E_ALLOW_DEVICE_AUTH: "1" },
  });
  const refused = resolveServiceDefinition({ ...MACHINES.darwin, environment: overrides });

  expect(allowed.contents).toContain("<string>/e2e/bin/coforge-computer</string>");
  expect(allowed.contents).toContain("ws://127.0.0.1:9999/connection/websocket");
  expect(refused).toEqual(resolveServiceDefinition(MACHINES.darwin));
});

test("the state directory does not depend on COFORGE_COMPUTER_HOME, which only moves credentials", () => {
  const moved = resolveServiceDefinition({
    ...MACHINES.darwin,
    environment: { COFORGE_COMPUTER_HOME: "/elsewhere" },
  });

  expect(moved).toEqual(resolveServiceDefinition(MACHINES.darwin));
});

/** Runs `__lifecycle service-definition` in process with the given definition and returns what the
 * installer would read: the exit status and the one JSON object on stdout. */
async function lifecycleServiceDefinition(definition: DaemonServiceDefinition) {
  const lines: string[] = [];
  const exitCode = await runLifecycleCommand(["service-definition"], {
    serviceDefinition: () => definition,
    write: (line) => lines.push(line),
  });
  return { exitCode, lines };
}

test.each(["darwin", "linux", "win32"] as const)(
  "%s: service-definition prints one JSON object naming the manager and the full text",
  async (platform) => {
    const definition = resolveServiceDefinition(MACHINES[platform]);

    const { exitCode, lines } = await lifecycleServiceDefinition(definition);

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    const printed = LifecycleServiceDefinitionSchema.parse(JSON.parse(lines[0]!));
    expect(printed).toEqual({
      lifecycle_protocol: 1,
      version: expect.any(String),
      manager: definition.manager,
      contents: definition.contents,
    });
    expect(printed.manager).toBe(SERVICE_MANAGER_BY_PLATFORM[platform]);
  },
);
