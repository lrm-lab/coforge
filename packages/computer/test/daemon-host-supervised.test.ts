import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSupervisorRecord,
  SystemdUserDaemonHost,
  writeSupervisorRecord,
} from "@lrm/coforge-daemon";
import { risingConnect } from "./accepting-connect";
import { recordingRegistrar } from "./recording-registrar";

/** A Computer under the person's own systemd unit (task #538): start and restart go to the
 * recorded unit; the registrar is never asked for a second service. */
const record = {
  kind: "systemd" as const,
  scope: "user" as const,
  unit: "mine.service",
  invocationId: "inv",
  pid: 7,
  recordedAt: "2026-11-05T00:00:00.000Z",
};

async function setup(answers: Record<string, { code: number | null; stdout?: string }>) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "supervised-host-"));
  await writeSupervisorRecord(stateDirectory, record);
  const calls: string[] = [];
  const registrar = recordingRegistrar();
  const host = new SystemdUserDaemonHost({
    serverUrl: "https://coforge.test",
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/run/user/501/coforge/daemon.sock",
    stateDirectory,
    connect: risingConnect("https://coforge.test"),
    registrar,
    run: async (command) => {
      calls.push(`own:${command.join(" ")}`);
      return { code: 0, stdout: "loaded\n", stderr: "" };
    },
    supervisorSystemctl: async (_scope, args) => {
      calls.push(args.join(" "));
      const a = answers[args.join(" ")];
      return { code: a?.code ?? 0, stdout: a?.stdout ?? "", stderr: "" };
    },
  });
  return { host, calls, registrar, stateDirectory };
}

const SHOW = "show -p LoadState -p ActiveState -p MainPID mine.service";
const LOADED = { [SHOW]: { code: 0, stdout: "LoadState=loaded\nActiveState=active\n" } };

test("a loaded recorded unit is started through itself, not the registrar or our own unit", async () => {
  const { host, calls, registrar } = await setup(LOADED);
  await host.ensureRunning();
  expect(registrar.calls).toBe(0);
  expect(calls.filter((c) => c.startsWith("own:"))).toEqual([]);
  expect(calls).toContain("start mine.service");
});

test("a restart goes to the recorded unit", async () => {
  const { host, calls, registrar } = await setup(LOADED);
  await host.restart();
  expect(registrar.calls).toBe(0);
  expect(calls).toContain("restart mine.service");
  expect(calls.filter((c) => c.startsWith("own:"))).toEqual([]);
});

test("a supervised Computer is restartable", async () => {
  const { host } = await setup(LOADED);
  await host.assertRestartable();
});

test("a recorded unit systemd forgot is cleared and the Computer manages itself again", async () => {
  const { host, registrar, stateDirectory } = await setup({
    [SHOW]: { code: 0, stdout: "LoadState=not-found\n" },
  });
  // Our own unit is answered "loaded" by the injected runner, so the plain start path runs.
  await host.ensureRunning().catch(() => undefined);
  expect(await readSupervisorRecord(stateDirectory)).toBeNull();
  expect(registrar.calls).toBe(0);
});

test("systemctl that cannot answer names the unit and refuses a second service", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "supervised-host-"));
  await writeSupervisorRecord(stateDirectory, record);
  const registrar = recordingRegistrar();
  const host = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/x/daemon.sock",
    stateDirectory,
    registrar,
    supervisorSystemctl: async () => ({ code: null, stdout: "", stderr: "ENOENT" }),
  });
  await expect(host.ensureRunning()).rejects.toThrow(
    "Not starting a second service beside the unit",
  );
  expect(registrar.calls).toBe(0);
});

test("a failing start of the recorded unit says which unit and why", async () => {
  const { host } = await setup({ ...LOADED, "start mine.service": { code: 5 } });
  await expect(host.ensureRunning()).rejects.toThrow("mine.service");
});

test.each(["matched", "unit changed", "invocation changed"] as const)(
  "verified systemd restart keeps its exact target when %s",
  async (scenario) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "verified-systemd-restart-"));
    const registrar = recordingRegistrar();
    const original = { ...record, scope: "system" as const };
    const calls: Array<{ scope: string; args: string[] }> = [];
    let invocation = "1".repeat(32);
    await writeSupervisorRecord(stateDirectory, original);
    const host = new SystemdUserDaemonHost({
      stateDirectory,
      homeDirectory: "/fixture",
      executablePath: "/fixture/coforge-computer",
      socketPath: "/fixture/daemon.sock",
      serverUrl: "https://coforge.test",
      connect: risingConnect("https://coforge.test"),
      registrar,
      async run() {
        throw new Error("The ordinary manager fallback must not run");
      },
      async supervisorSystemctl(scope, args) {
        calls.push({ scope, args });
        return {
          code: 0,
          stdout: `LoadState=loaded\nMainPID=7\nInvocationID=${invocation}\n`,
          stderr: "",
        };
      },
    });
    try {
      const execute = await host.prepareRestart(7);
      expect(execute).toBeDefined();
      if (scenario === "unit changed")
        await writeSupervisorRecord(stateDirectory, { ...record, unit: "hosting.service" });
      if (scenario === "invocation changed") invocation = "2".repeat(32);
      expect(await execute?.()).toBe(scenario === "matched");
      const show = {
        scope: "system",
        args: [
          "show",
          "--property=LoadState",
          "--property=MainPID",
          "--property=InvocationID",
          "mine.service",
        ],
      };
      expect(calls).toEqual(
        scenario === "matched"
          ? [show, show, { scope: "system", args: ["restart", "mine.service"] }]
          : [show, show],
      );
      expect(registrar.calls).toBe(0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);
