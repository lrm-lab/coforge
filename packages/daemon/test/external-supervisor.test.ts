import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSupervisorRecord,
  describeSupervisorUnreachable,
  detectSystemdSupervisor,
  externalSupervisorOptIn,
  inspectSupervisor,
  parseSystemdUnitFromCgroup,
  readSupervisorRecord,
  writeSupervisorRecord,
  type SystemctlRunner,
} from "#src/daemon-host/external-supervisor";

const USER_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/coforge-daemon.service\n";
const SYSTEM_CGROUP = "0::/system.slice/coforge-daemon.service\n";

test("only 1 or true opts in to external supervision", () => {
  expect(externalSupervisorOptIn({ COFORGE_COMPUTER_EXTERNAL_SUPERVISOR: "1" })).toBe(true);
  expect(externalSupervisorOptIn({ COFORGE_COMPUTER_EXTERNAL_SUPERVISOR: " TRUE " })).toBe(true);
  expect(externalSupervisorOptIn({ COFORGE_COMPUTER_EXTERNAL_SUPERVISOR: "0" })).toBe(false);
  expect(externalSupervisorOptIn({})).toBe(false);
});

test("the unit and scope come from the cgroup's .service segment, user@N.service excluded", () => {
  expect(parseSystemdUnitFromCgroup(USER_CGROUP)).toEqual({
    unit: "coforge-daemon.service",
    scope: "user",
  });
  expect(parseSystemdUnitFromCgroup(SYSTEM_CGROUP)).toEqual({
    unit: "coforge-daemon.service",
    scope: "system",
  });
  expect(
    parseSystemdUnitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service\n"),
  ).toBeNull();
  expect(parseSystemdUnitFromCgroup("0::/init.scope\n")).toBeNull();
});

const runner =
  (
    answers: Record<string, { code: number | null; stdout?: string; stderr?: string }>,
  ): SystemctlRunner =>
  async (_scope, args) => {
    const a = answers[args.join(" ")];
    return { code: a?.code ?? 1, stdout: a?.stdout ?? "", stderr: a?.stderr ?? "" };
  };

const base = {
  platform: "linux" as const,
  env: { INVOCATION_ID: "inv-1" },
  pid: 4242,
  readCgroup: async () => USER_CGROUP,
  now: () => new Date("2026-11-05T00:00:00Z"),
};

test("a supervisor is detected only when the unit's MainPID is this process", async () => {
  const mainPid = (stdout: string) =>
    runner({ "show -P MainPID coforge-daemon.service": { code: 0, stdout } });
  expect(await detectSystemdSupervisor({ ...base, systemctl: mainPid("4242\n") })).toEqual({
    kind: "systemd",
    scope: "user",
    unit: "coforge-daemon.service",
    invocationId: "inv-1",
    pid: 4242,
    recordedAt: "2026-11-05T00:00:00.000Z",
  });
  expect(await detectSystemdSupervisor({ ...base, systemctl: mainPid("1\n") })).toBeNull();
  expect(await detectSystemdSupervisor({ ...base, systemctl: runner({}) })).toBeNull();
  expect(
    await detectSystemdSupervisor({ ...base, env: {}, systemctl: mainPid("4242\n") }),
  ).toBeNull();
  expect(
    await detectSystemdSupervisor({ ...base, platform: "darwin", systemctl: mainPid("4242\n") }),
  ).toBeNull();
});

test("the record round-trips and a malformed one reads as none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-"));
  expect(await readSupervisorRecord(dir)).toBeNull();
  const record = {
    kind: "systemd" as const,
    scope: "user" as const,
    unit: "coforge-daemon.service",
    invocationId: "inv-1",
    pid: 4242,
    recordedAt: "2026-11-05T00:00:00.000Z",
  };
  await writeSupervisorRecord(dir, record);
  expect(await readSupervisorRecord(dir)).toEqual(record);
  await Bun.write(join(dir, "supervisor.json"), JSON.stringify({ ...record, unit: "x.sh" }));
  expect(await readSupervisorRecord(dir)).toBeNull();
  await writeSupervisorRecord(dir, record);
  await clearSupervisorRecord(dir);
  expect(await readSupervisorRecord(dir)).toBeNull();
  expect(await Bun.file(join(dir, "supervisor.json")).exists()).toBe(false);
});

const recordFor = async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-"));
  await writeSupervisorRecord(dir, {
    kind: "systemd",
    scope: "user",
    unit: "coforge-daemon.service",
    invocationId: "inv-1",
    pid: 4242,
    recordedAt: "2026-11-05T00:00:00.000Z",
  });
  return dir;
};

test("no record means no supervisor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-"));
  expect(await inspectSupervisor(dir, { systemctl: runner({}) })).toBeNull();
});

test("a loaded unit is reported with its state", async () => {
  const dir = await recordFor();
  const view = await inspectSupervisor(dir, {
    systemctl: runner({
      "show -P LoadState coforge-daemon.service": { code: 0, stdout: "loaded\n" },
      "is-enabled coforge-daemon.service": { code: 0, stdout: "enabled\n" },
      "show -P ActiveState coforge-daemon.service": { code: 0, stdout: "active\n" },
      "show -P MainPID coforge-daemon.service": { code: 0, stdout: "4242\n" },
      "show -P KillMode coforge-daemon.service": { code: 0, stdout: "control-group\n" },
    }),
  });
  expect(view).toMatchObject({
    unitLoaded: true,
    reachable: true,
    enabledState: "enabled",
    activeState: "active",
    mainPid: 4242,
    killMode: "control-group",
  });
});

test("a unit systemd no longer knows is reachable but not loaded", async () => {
  const dir = await recordFor();
  const view = await inspectSupervisor(dir, {
    systemctl: runner({
      "show -P LoadState coforge-daemon.service": { code: 0, stdout: "not-found\n" },
    }),
  });
  expect(view).toMatchObject({ unitLoaded: false, reachable: true });
});

test("a systemctl that cannot answer is unreachable, not gone", async () => {
  const dir = await recordFor();
  const view = await inspectSupervisor(dir, {
    systemctl: async () => ({ code: null, stdout: "", stderr: "spawn systemctl ENOENT" }),
  });
  expect(view).toMatchObject({ unitLoaded: false, reachable: false });
});

test("the unreachable message names the unit and refuses a second service", () => {
  const text = describeSupervisorUnreachable(
    { kind: "systemd", scope: "user", unit: "coforge-daemon.service" } as never,
    "systemctl did not answer",
  );
  expect(text).toContain("coforge-daemon.service");
  expect(text).toContain("user scope");
  expect(text).toContain("XDG_RUNTIME_DIR");
  expect(text).toContain("Not starting a second service beside the unit");
});
