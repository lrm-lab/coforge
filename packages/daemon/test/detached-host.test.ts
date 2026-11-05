import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDaemonHost,
  DetachedDaemonHost,
  SystemdUserDaemonHost,
} from "#src/daemon-host/index";
import { detachedPid, systemdPresent } from "#src/daemon-host/detached";
import { DAEMON_SERVICE_MANAGERS } from "#src/daemon-host/launcher";

const registrar = () => {
  const calls = { count: 0 };
  return {
    calls,
    registerAndStart: async () => {
      calls.count++;
    },
  };
};

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "detached-host-"));
  return state;
}

test("systemd is present only with a running manager and a systemctl on PATH", async () => {
  const run = await mkdtemp(join(tmpdir(), "run-"));
  const bin = await mkdtemp(join(tmpdir(), "bin-"));
  expect(systemdPresent({ runDirectory: run, path: bin })).toBe(false);
  await mkdir(join(run, "systemd", "system"), { recursive: true });
  expect(systemdPresent({ runDirectory: run, path: bin })).toBe(false);
  await writeFile(join(bin, "systemctl"), "");
  await chmod(join(bin, "systemctl"), 0o755);
  expect(systemdPresent({ runDirectory: run, path: bin })).toBe(true);
  expect(systemdPresent({ runDirectory: run, path: undefined })).toBe(false);
  expect(systemdPresent({ runDirectory: await mkdtemp(join(tmpdir(), "run-")), path: bin })).toBe(
    false,
  );
});

test("detached is a service manager the contract knows", () => {
  expect(DAEMON_SERVICE_MANAGERS).toContain("detached");
});

function host(
  state: string,
  over: Partial<ConstructorParameters<typeof DetachedDaemonHost>[0]> = {},
) {
  const reg = registrar();
  return {
    reg,
    host: new DetachedDaemonHost({
      homeDirectory: "/home/alice",
      executablePath: "/install/coforge-computer",
      socketPath: "/run/user/501/coforge/daemon.sock",
      stateDirectory: state,
      daemonConnectionEndpoint: "https://coforge.test/connect",
      runtimeHomeDirectory: "/home/alice",
      registrar: reg,
      processStartedAt: async (pid) => (pid === 4000 ? 900 : null),
      ...over,
    }),
  };
}

test("the definition is the unit's command and environment, with no credential in it", async () => {
  const state = await fixture();
  const { host: h } = host(state);
  const definition = h.serviceDefinition();
  expect(definition.manager).toBe("detached");
  expect(definition.path).toBe(join(state, "detached-service.json"));
  const spec = JSON.parse(definition.contents);
  expect(spec.program).toBe("/install/coforge-computer");
  expect(spec.args).toEqual([
    "__daemon",
    "--socket",
    "/run/user/501/coforge/daemon.sock",
    "--state-directory",
    state,
  ]);
  expect(Object.keys(spec.env).sort()).toEqual(["COFORGE_DAEMON_CONNECTION_ENDPOINT", "HOME"]);
  for (const name of Object.keys(spec.env))
    expect(name).not.toMatch(/key|token|secret|password|credential|auth/i);
});

test("a pid file naming the live process of that start time is running; a reused pid is not", async () => {
  const state = await fixture();
  await writeFile(join(state, "detached.pid"), "4000 900");
  const alive = async (pid: number) => (pid === 4000 ? 900 : null);
  expect(await detachedPid(state, alive)).toBe(4000);
  expect(await detachedPid(state, async () => 31337)).toBeNull();
  expect(await detachedPid(state, async () => null)).toBeNull();
  expect(await detachedPid(await fixture(), alive)).toBeNull();
});

test("a running process is not started again; a missing one goes through the registrar once", async () => {
  const state = await fixture();
  const { host: h, reg } = host(state, {
    connect: async () => {
      throw new Error("connect is not the point here");
    },
  });
  await expect(h.ensureRunning()).rejects.toThrow();
  expect(reg.calls.count).toBe(1);
  await writeFile(join(state, "detached.pid"), "4000 900");
  await expect(h.ensureRunning()).rejects.toThrow();
  expect(reg.calls.count).toBe(1);
});

test("stopping something that is not running only clears the pid file", async () => {
  const state = await fixture();
  await writeFile(join(state, "detached.pid"), "4000 1");
  const { host: h } = host(state);
  await h.stop();
  expect(await Bun.file(join(state, "detached.pid")).exists()).toBe(false);
});

test("linux picks the host by systemd; darwin and win32 never get the detached one", () => {
  const input = {
    executablePath: "/install/coforge-computer",
    socketPath: "/x/daemon.sock",
    homeDirectory: "/home/alice",
    uid: 501,
    registrar: registrar(),
  };
  expect(createDaemonHost({ ...input, platform: "linux", hasSystemd: true })).toBeInstanceOf(
    SystemdUserDaemonHost,
  );
  expect(createDaemonHost({ ...input, platform: "linux", hasSystemd: false })).toBeInstanceOf(
    DetachedDaemonHost,
  );
  for (const platform of ["darwin", "win32"] as const)
    for (const hasSystemd of [true, false])
      expect(createDaemonHost({ ...input, platform, hasSystemd })).not.toBeInstanceOf(
        DetachedDaemonHost,
      );
});
