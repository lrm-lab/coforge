import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSupervisorRecord,
  SystemdUserDaemonHost,
  writeSupervisorRecord,
} from "@lrm/coforge-daemon";
import { acceptingConnect } from "./accepting-connect";
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
    connect: acceptingConnect("https://coforge.test"),
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

const SHOW = "show -p LoadState -p ActiveState -p MainPID -p KillMode mine.service";
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
