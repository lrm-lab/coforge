import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileBindingStore,
  FileDaemonCredentialStore,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";
import { holdWorkspaceDaemonLock } from "@lrm/coforge-daemon/src/supervisor/workspace-daemon-lock";
import {
  createDoctorCommand,
  createDoctorReport,
  renderDoctorHuman,
} from "#src/doctor/doctor-command";
import { FileComputerConfig } from "#src/local-config";
import { collectComputerStatus } from "#src/status/collect-status";
import { createStatusPorts } from "#src/status/create-status-ports";
import { renderStatusHuman } from "#src/status/render-status";
import type { ComputerStatusReport, StatusPorts } from "#src/status/types";

const tempDirs: string[] = [];
const heldLocks: { release(): void }[] = [];

afterEach(async () => {
  for (const lock of heldLocks.splice(0)) lock.release();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function basePorts(overrides: Partial<StatusPorts> = {}): StatusPorts {
  return {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "darwin",
    releaseFeedUrl: "https://releases.coforge.cn/",
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    activeBinaryPath: "/home/user/.coforge/computer/install/active/coforge-computer",
    coordinatorLabel: "cn.coforge.computer.daemon",
    readActiveInstall: async () => ({ kind: "present", current: "1.4.2", previous: "1.4.1" }),
    readLoginShellPath: () => ({ state: "imported", shell: "/bin/zsh", entryCount: 5 }),
    locateBinaryOnPath: async () => "/home/user/.local/bin/coforge-computer",
    resolveRealPath: async () =>
      "/home/user/.coforge/computer/install/versions/1.4.2/coforge-computer",
    probeCoordinator: async () => ({ loaded: true, pid: 4821 }),
    readServiceDefinition: async () => null,
    probeDaemonSnapshot: async () => ({
      reachable: true,
      version: "1.4.2",
      runtimes: [{ workspaceId: "ws-1", processId: 111 }],
    }),
    loadBindings: async () => ({
      ok: true,
      bindings: [
        {
          workspaceId: "ws-1",
          computerId: "comp-1",
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
        },
      ],
    }),
    listWorkspaceAgents: { supported: false, list: async () => [] },
    probeMachineMutationLock: () => "free",
    readSupervisorLockOwner: async () => 4821,
    listLeftoverUpgradeJobs: { supported: false, list: async () => [] },
    readWorkspaceHealth: async () => ({ status: "ok" }),
    readCloudConnection: async () => ({ state: "connected" }),
    readWorkspaceSlugs: async () => new Map([["ws-1", "acme"]]),
    ...overrides,
  };
}

test("status and doctor detect an unfinished installer-transaction.json and recommend repair", async () => {
  const root = await makeTempDir("coforge-diag-journal-");
  const installDir = join(root, "install");
  const stateDir = join(root, "daemon");
  const configDir = join(root, "computer");
  await mkdir(installDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(installDir, "active.json"),
    JSON.stringify({ schema_version: 1, current: "1.4.2", previous: "1.4.1" }),
  );
  await writeFile(
    join(installDir, "installer-transaction.json"),
    JSON.stringify({
      schema_version: 1,
      request_id: "req-half-settled",
      from: "1.4.1",
      from_previous: "1.4.0",
      to: "1.4.2",
      supervisor_running: true,
    }),
  );

  const ports = createStatusPorts({
    platform: "darwin",
    installDirectory: installDir,
    stateDirectory: stateDir,
    releaseFeedUrl: "https://releases.coforge.cn/",
    serverUrl: "https://coforge.cn",
    registrations: new FileComputerConfig(configDir),
    environment: { PATH: "" },
  });

  const status = await collectComputerStatus({
    ...ports,
    locateBinaryOnPath: async () => "/usr/local/bin/coforge-computer",
    resolveRealPath: async () => join(installDir, "versions/1.4.2/coforge-computer"),
    probeCoordinator: async () => ({ loaded: true, pid: 100 }),
    readServiceDefinition: async () => null,
    probeDaemonSnapshot: async () => ({ reachable: true, runtimes: [] }),
  });

  expect(status.install.readable).toBe(true);
  if (status.install.readable) {
    expect(status.install.unfinishedTransaction).toEqual({
      valid: true,
      requestId: "req-half-settled",
      from: "1.4.1",
      to: "1.4.2",
      supervisorRunning: true,
    });
  }

  const humanStatus = renderStatusHuman(status).join("\n");
  expect(humanStatus).toContain("Unfinished upgrade:");
  expect(humanStatus).toContain("1.4.1 -> 1.4.2");
  expect(humanStatus).toContain("coforge-computer repair");

  const doctor = createDoctorReport(status);
  expect(doctor.checks[0]?.ok).toBe(false);
  expect(doctor.checks[0]?.detail).toContain("installer-transaction.json");
  expect(renderDoctorHuman(doctor)).toContain("  Next: coforge-computer repair");

  // Corrupt installer-transaction.json also fails closed and points to repair.
  await writeFile(join(installDir, "installer-transaction.json"), "{broken");
  const corruptStatus = await collectComputerStatus({
    ...ports,
    locateBinaryOnPath: async () => "/usr/local/bin/coforge-computer",
    resolveRealPath: async () => join(installDir, "versions/1.4.2/coforge-computer"),
    probeCoordinator: async () => ({ loaded: true, pid: 100 }),
    readServiceDefinition: async () => null,
    probeDaemonSnapshot: async () => ({ reachable: true, runtimes: [] }),
  });
  expect(corruptStatus.install.readable && corruptStatus.install.unfinishedTransaction).toEqual({
    valid: false,
    error: "installer-transaction.json is not valid JSON",
  });
  expect(renderDoctorHuman(createDoctorReport(corruptStatus))).toContain(
    "  Next: coforge-computer repair",
  );
});

test("status and doctor detect SERVICE_VERSION_SKEW on Coordinator and Workspace handshakes", async () => {
  const status = await collectComputerStatus(
    basePorts({
      probeDaemonSnapshot: async () => ({
        reachable: true,
        version: "1.4.1",
        runtimes: [{ workspaceId: "ws-1", processId: 111 }],
      }),
      readWorkspaceHandshake: async () => ({
        version: "1.4.0",
        cloudConnection: { state: "connected" },
      }),
    }),
  );

  expect(status.supervisor.rpc).toEqual({
    reachable: true,
    runtimeCount: 1,
    version: "1.4.1",
    versionSkew: true,
  });
  expect(status.workspaces.readable && status.workspaces.workspaces[0]).toMatchObject({
    version: "1.4.0",
    versionSkew: true,
  });

  const humanStatus = renderStatusHuman(status).join("\n");
  expect(humanStatus).toContain("SERVICE_VERSION_SKEW (running 1.4.1, active 1.4.2)");
  expect(humanStatus).toContain("SERVICE_VERSION_SKEW (running 1.4.0, active 1.4.2)");

  const doctor = createDoctorReport(status);
  expect(doctor.ok).toBe(false);
  expect(doctor.checks.find((c) => c.name === "supervisor")).toEqual({
    name: "supervisor",
    ok: false,
    detail:
      "SERVICE_VERSION_SKEW: running supervisor version 1.4.1 differs from active version 1.4.2",
  });
  expect(doctor.checks.find((c) => c.name === "workspaces")?.detail).toContain(
    "acme: SERVICE_VERSION_SKEW (running 1.4.0, active 1.4.2)",
  );
});

test("status and doctor surface contending workspace-daemon-lock.sqlite holder PID without false alarms on self-owned locks", async () => {
  const root = await makeTempDir("coforge-diag-lock-");
  const stateDir = join(root, "daemon");
  const wsDir = workspaceStateDirectory(stateDir, "ws-1");
  const lock = await holdWorkspaceDaemonLock(wsDir, { pid: 9876 });
  heldLocks.push(lock);

  const ports = createStatusPorts({
    platform: "darwin",
    installDirectory: join(root, "install"),
    stateDirectory: stateDir,
    releaseFeedUrl: "https://releases.coforge.cn/",
    serverUrl: "https://coforge.cn",
    registrations: new FileComputerConfig(join(root, "computer")),
    environment: { PATH: "" },
  });

  // 1. Orphan holds lock while Workspace is not running -> flagged as contention!
  const contended: ComputerStatusReport = await collectComputerStatus(
    basePorts({
      probeDaemonSnapshot: async () => ({ reachable: true, runtimes: [] }),
      readWorkspaceLock: ports.readWorkspaceLock,
    }),
  );
  expect(contended.workspaces.readable && contended.workspaces.workspaces[0]).toMatchObject({
    running: false,
    lockContention: { holderPid: 9876 },
  });
  expect(renderStatusHuman(contended).join("\n")).toContain(
    "lock contention: workspace-daemon-lock.sqlite is held by pid 9876",
  );
  expect(renderStatusHuman(contended).join("\n")).toContain(
    "Workspace lock (acme): held by contending pid 9876",
  );
  const contendedDoctor = createDoctorReport(contended);
  expect(contendedDoctor.checks.find((c) => c.name === "locks")).toEqual({
    name: "locks",
    ok: false,
    detail: "workspace lock for acme is held by contending pid 9876",
  });

  // 2. Healthy running Workspace holds its own lock (pid 9876 === 9876) -> NOT contention!
  const healthy = await collectComputerStatus(
    basePorts({
      probeDaemonSnapshot: async () => ({
        reachable: true,
        version: "1.4.2",
        runtimes: [{ workspaceId: "ws-1", processId: 9876 }],
      }),
      readWorkspaceLock: ports.readWorkspaceLock,
    }),
  );
  expect(
    healthy.workspaces.readable && healthy.workspaces.workspaces[0]?.lockContention,
  ).toBeUndefined();
  expect(createDoctorReport(healthy).ok).toBe(true);
});

test("doctor probes GET /api/computer/self and flags server-revoked sk_computer keys on stopped bindings", async () => {
  const root = await makeTempDir("coforge-diag-self-");
  const installDir = join(root, "install");
  const stateDir = join(root, "daemon");
  const configDir = join(root, "computer");
  await mkdir(installDir, { recursive: true });
  await writeFile(
    join(installDir, "active.json"),
    JSON.stringify({ schema_version: 1, current: "1.4.2", previous: null }),
  );

  let selfCalls = 0;
  let statusCode = 401;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/computer/self") {
        selfCalls += 1;
        expect(request.headers.get("authorization")).toBe("Bearer sk_computer_revoked_test");
        return new Response(JSON.stringify({ ok: statusCode === 200 }), { status: statusCode });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const serverOrigin = server.url.origin;
    const config = new FileComputerConfig(configDir);
    await config.saveRegistration({ id: "ws-stopped", slug: "stopped-ws", computerId: "comp-1" });
    await new FileBindingStore(stateDir, serverOrigin).save([
      {
        workspaceId: "ws-stopped",
        computerId: "comp-1",
        workspaceRoot: join(root, "ws-root"),
        serverHttpUrl: serverOrigin,
        enabled: false,
      },
    ]);
    await new FileDaemonCredentialStore(workspaceStateDirectory(stateDir, "ws-stopped")).save(
      "ws-stopped",
      "comp-1",
      "sk_computer_revoked_test",
    );

    const realPorts = createStatusPorts({
      platform: "darwin",
      installDirectory: installDir,
      stateDirectory: stateDir,
      releaseFeedUrl: "https://releases.coforge.cn/",
      serverUrl: serverOrigin,
      registrations: config,
    });
    const ports: StatusPorts = {
      ...realPorts,
      locateBinaryOnPath: async () => "/usr/local/bin/coforge-computer",
      resolveRealPath: async () => join(installDir, "versions/1.4.2/coforge-computer"),
      probeCoordinator: async () => ({ loaded: true, pid: 4821 }),
      readServiceDefinition: async () => null,
      readLoginShellPath: () => ({ state: "imported", shell: "/bin/zsh", entryCount: 3 }),
      probeDaemonSnapshot: async () => ({ reachable: true, version: "1.4.2", runtimes: [] }),
      listWorkspaceAgents: { supported: false, list: async () => [] },
      listLeftoverUpgradeJobs: { supported: false, list: async () => [] },
    };

    // `status` alone must stay local and never call GET /api/computer/self.
    await collectComputerStatus(ports);
    expect(selfCalls).toBe(0);

    // `doctor` probes GET /api/computer/self and flags the revoked key on the stopped binding!
    const out: string[] = [];
    const doctorCmd = createDoctorCommand({ stdout: (line) => out.push(line) }, ports);
    expect(await doctorCmd.run({ json: true })).toBe(1);
    expect(selfCalls).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c: { name: string }) => c.name === "workspaces")).toEqual({
      name: "workspaces",
      ok: false,
      detail: "stopped-ws: server revoked sk_computer credential",
    });

    // When the server accepts the key (200), the stopped binding is not flagged as revoked.
    statusCode = 200;
    out.length = 0;
    expect(await doctorCmd.run({ json: true })).toBe(0);
    expect(selfCalls).toBe(2);
    expect(JSON.parse(out[0]!).ok).toBe(true);
  } finally {
    server.stop(true);
  }
});
