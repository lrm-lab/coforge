import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LaunchdWorkspaceInstance } from "#src/supervisor/launchd-workspace-instance";
import {
  platformWorkspaceInstance,
  workspaceInstanceConfig,
  type WorkspaceInstanceHost,
} from "#src/supervisor/platform-workspace-instance";
import { SystemdWorkspaceInstance } from "#src/supervisor/systemd-workspace-instance";
import { ProcessWorkspaceInstance } from "#src/supervisor/process-workspace-instance";
import { workspaceStateDirectory } from "#src/supervisor/workspace-instance";
import { workspaceSocketPath } from "#src/supervisor/workspace-start-outcome";

const stateRoot = "/state";
const host = (platform: NodeJS.Platform): WorkspaceInstanceHost => ({
  platform,
  homeDirectory: "/home/someone",
  executablePath: "/bin/coforge-computer",
  daemonConnectionEndpoint: "wss://example.test/connection",
});

describe("workspaceInstanceConfig", () => {
  test("names the Workspace's socket, state directory, the supervisor socket and the endpoint", () => {
    expect(workspaceInstanceConfig(stateRoot, "/state/daemon.sock", "w1", host("linux"))).toEqual({
      stateRoot,
      workspaceId: "w1",
      executablePath: "/bin/coforge-computer",
      socketPath: workspaceSocketPath(stateRoot, "w1"),
      stateDirectory: workspaceStateDirectory(stateRoot, "w1"),
      unitDirectory: join("/home/someone", ".config", "systemd", "user"),
      supervisorSocketPath: "/state/daemon.sock",
      daemonConnectionEndpoint: "wss://example.test/connection",
    });
  });

  test("puts the unit files where each platform's service manager reads them", () => {
    const unitDirectory = (platform: NodeJS.Platform) =>
      workspaceInstanceConfig(stateRoot, "/s.sock", "w1", host(platform)).unitDirectory;
    expect(unitDirectory("darwin")).toBe(join(stateRoot, "launchd-workspaces"));
    expect(unitDirectory("win32")).toBe(join(stateRoot, "windows-workspaces"));
    expect(unitDirectory("linux")).toBe(join("/home/someone", ".config", "systemd", "user"));
  });
});

describe("platformWorkspaceInstance", () => {
  const instanceOn = (platform: NodeJS.Platform, systemd = true) =>
    platformWorkspaceInstance(
      workspaceInstanceConfig(stateRoot, "/s.sock", "w1", host(platform)),
      platform,
      () => systemd,
    );

  test("contains a Workspace with the platform's own service manager", () => {
    expect(instanceOn("linux")).toBeInstanceOf(SystemdWorkspaceInstance);
    expect(instanceOn("darwin")).toBeInstanceOf(LaunchdWorkspaceInstance);
    expect(instanceOn("win32")).toBeInstanceOf(ProcessWorkspaceInstance);
  });

  test("a Linux host without systemd contains the Workspace in a child process, never systemctl", () => {
    expect(instanceOn("linux", false)).toBeInstanceOf(ProcessWorkspaceInstance);
    // The same detection `task #538` uses for the Computer: no systemd, no service manager call.
    let asked = 0;
    const instance = platformWorkspaceInstance(
      workspaceInstanceConfig(stateRoot, "/s.sock", "w1", host("linux")),
      "linux",
      () => {
        asked++;
        return false;
      },
    );
    expect(asked).toBe(1);
    expect(instance).toBeInstanceOf(ProcessWorkspaceInstance);
  });

  test("refuses a platform without per-Workspace OS containment", () => {
    expect(() => instanceOn("freebsd")).toThrow(
      "per-Workspace OS containment is not implemented on this platform",
    );
  });
});
