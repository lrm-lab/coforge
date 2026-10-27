import { expect, test } from "bun:test";

import { runCli, type DoctorCommand } from "#src/cli";
import {
  createDoctorCommand,
  createDoctorReport,
  renderDoctorHuman,
  renderDoctorJson,
} from "#src/doctor/doctor-command";
import type { ComputerStatusReport } from "#src/status/types";

const HEALTHY_REPORT: ComputerStatusReport = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  platform: "darwin",
  install: {
    readable: true,
    active: { current: "1.4.2", previous: "1.4.1" },
    binaryOnPath: "/home/user/.local/bin/coforge-computer",
    resolvesToActive: true,
    releaseFeedUrl: "https://releases.coforge.cn/",
  },
  supervisor: {
    label: "cn.coforge.computer.daemon",
    loaded: true,
    pid: 4821,
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    rpc: { reachable: true, runtimeCount: 1 },
    serviceDefinition: { state: "not_checked" },
  },
  loginShellPath: { state: "imported", shell: "/bin/zsh", entryCount: 7 },
  workspaces: {
    readable: true,
    workspaces: [
      {
        workspaceId: "ws-1",
        workspaceSlug: "acme",
        serverHttpUrl: "https://coforge.cn",
        enabled: true,
        running: true,
        pid: 111,
        pidSource: "daemon-snapshot",
        pending: [],
        unsettledUpgrades: [],
        health: { status: "ok" },
        cloudConnection: { state: "connected" },
      },
    ],
  },
  agents: { supported: true, workspaces: [] },
  locks: {
    machineMutationLock: "free",
    supervisorLock: { present: true, ownerPid: 4821 },
  },
  leftoverJobs: { supported: true, jobs: [] },
};
const healthyInstall = HEALTHY_REPORT.install;
if (!healthyInstall.readable) throw new Error("test fixture install must be readable");
const healthyWorkspaces = HEALTHY_REPORT.workspaces;
if (!healthyWorkspaces.readable) throw new Error("test fixture workspaces must be readable");

test("doctor reports a healthy machine from the read-only status snapshot", () => {
  const report = createDoctorReport(HEALTHY_REPORT);

  expect(report.ok).toBe(true);
  expect(report.checks).toEqual([
    { name: "install", ok: true, detail: "active version 1.4.2 is selected" },
    { name: "supervisor", ok: true, detail: "local RPC is reachable" },
    {
      name: "locks",
      ok: true,
      detail: "machine mutation lock free; supervisor lock held by pid 4821",
    },
    { name: "login-shell-path", ok: true, detail: "imported from /bin/zsh" },
    { name: "workspaces", ok: true, detail: "1 enabled workspace is running and connected" },
    { name: "leftover-upgrade-jobs", ok: true, detail: "none" },
  ]);
});

test("doctor identifies actionable failures without mutating the status snapshot", () => {
  const report = createDoctorReport({
    ...HEALTHY_REPORT,
    install: { readable: false, error: "active.json is not valid JSON" },
    supervisor: {
      ...HEALTHY_REPORT.supervisor,
      rpc: { reachable: false, error: "connect ENOENT daemon.sock" },
    },
    workspaces: {
      readable: true,
      workspaces: [
        {
          ...healthyWorkspaces.workspaces[0]!,
          running: false,
          pid: null,
          pidSource: null,
          cloudConnection: null,
          health: { status: "degraded", reason: "crash_loop", crashCount: 3, since: "2026-01-01" },
        },
      ],
    },
    leftoverJobs: {
      supported: true,
      jobs: [{ label: "cn.coforge.upgrade.old", pid: null, runs: 2 }],
    },
  });

  expect(report.ok).toBe(false);
  expect(report.checks).toEqual([
    { name: "install", ok: false, detail: "active.json is not valid JSON" },
    {
      name: "supervisor",
      ok: false,
      detail: "local RPC is unreachable: connect ENOENT daemon.sock",
    },
    {
      name: "locks",
      ok: true,
      detail: "machine mutation lock free; supervisor lock held by pid 4821",
    },
    { name: "login-shell-path", ok: true, detail: "imported from /bin/zsh" },
    {
      name: "workspaces",
      ok: false,
      detail: "acme: enabled but not running; health=degraded (crash_loop)",
    },
    { name: "leftover-upgrade-jobs", ok: false, detail: "1 leftover upgrade job" },
  ]);
});

test("doctor reports a held mutation lock as an actionable local condition", () => {
  const report = createDoctorReport({
    ...HEALTHY_REPORT,
    locks: {
      machineMutationLock: "held",
      supervisorLock: { present: false, ownerPid: null },
    },
  });

  expect(report.ok).toBe(false);
  expect(report.checks).toContainEqual({
    name: "locks",
    ok: false,
    detail:
      "machine mutation lock is held; an install, upgrade, repair, or recovery may be running",
  });
});

test("doctor treats an unattached machine as an actionable setup condition", () => {
  const report = createDoctorReport({
    ...HEALTHY_REPORT,
    workspaces: { readable: true, workspaces: [] },
  });

  expect(report.ok).toBe(false);
  expect(report.checks).toContainEqual({
    name: "workspaces",
    ok: false,
    detail: "no workspace bindings configured",
  });
  expect(renderDoctorHuman(report)).toContain("  Next: coforge-computer setup --workspace <slug>");
});

test("doctor fails when the active install is not discoverable on PATH", () => {
  const report = createDoctorReport({
    ...HEALTHY_REPORT,
    install: { ...healthyInstall, binaryOnPath: null },
  });

  expect(report.ok).toBe(false);
  expect(report.checks[0]).toEqual({
    name: "install",
    ok: false,
    detail: "the Computer executable was not found on PATH",
  });
});

test("doctor renders stable JSON and concise human output", async () => {
  const stdout: string[] = [];
  const command = createDoctorCommand(
    { stdout: (line) => stdout.push(line) },
    async () => HEALTHY_REPORT,
  );

  await expect(command.run({ json: true })).resolves.toBe(0);
  expect(JSON.parse(stdout[0]!)).toEqual(createDoctorReport(HEALTHY_REPORT));

  const human = renderDoctorHuman(createDoctorReport(HEALTHY_REPORT));
  expect(human.join("\n")).toContain("✓ install: active version 1.4.2 is selected");
  expect(human.at(-1)).toBe("Result: healthy");
  expect(renderDoctorJson(createDoctorReport(HEALTHY_REPORT))).not.toContain("\n");
});

test("doctor human output gives the next command for failed checks", () => {
  const lines = renderDoctorHuman(
    createDoctorReport({
      ...HEALTHY_REPORT,
      install: {
        readable: true,
        active: null,
        binaryOnPath: null,
        resolvesToActive: null,
        releaseFeedUrl: "https://releases.coforge.cn/",
      },
      supervisor: {
        ...HEALTHY_REPORT.supervisor,
        loaded: false,
        rpc: { reachable: false, error: "connect ENOENT daemon.sock" },
      },
      workspaces: { readable: true, workspaces: [] },
      leftoverJobs: {
        supported: true,
        jobs: [{ label: "cn.coforge.upgrade.old", pid: null, runs: 1 }],
      },
    }),
  );

  expect(lines).toContain("  Next: coforge-computer install");
  expect(lines).toContain("  Next: coforge-computer restart --supervisor");
  expect(lines).toContain("  Next: coforge-computer restart --supervisor");
});

test("doctor CLI forwards JSON mode and preserves a failing diagnostic exit code", async () => {
  const calls: Array<{ json: boolean }> = [];
  const doctor: DoctorCommand = {
    async run(options) {
      calls.push(options);
      return 1;
    },
  };

  await expect(
    runCli(
      ["doctor", "--json"],
      { login: { async run() {} }, setup: { async run() {} }, doctor },
      { stdout: () => undefined, stderr: () => undefined },
    ),
  ).resolves.toBe(1);
  expect(calls).toEqual([{ json: true }]);
});
