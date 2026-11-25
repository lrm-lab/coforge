import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@lrm/coforge";
import { connectLocal } from "@lrm/coforge/local-client";
import {
  decodeAgentProcListResponse,
  decodeAgentProcLogsResponse,
  decodeAgentProcStartResponse,
} from "@lrm/coforge-sdk/agent";
import {
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  daemonAgentProxyRuntime,
  listMachineRunningProcJobs,
  startAgentProxy,
  stopMachineRunningProcJobs,
  workspaceStateDirectory,
  type AgentRuntimeConfig,
  type DaemonConfig,
} from "@lrm/coforge-daemon";
import { createProcJobMemoryScopeDetector } from "@lrm/coforge-daemon/src/platform/proc-job-systemd-capability";
import { stopComputer } from "#src/cli/stop-computer";
import { collectComputerStatus } from "#src/status/collect-status";
import { createStatusPorts } from "#src/status/create-status-ports";

const tempRoot = realpathSync(await mkdtemp(join(tmpdir(), "coforge-proc-e2e-")));
const cleanupPids = new Set<number>();

afterEach(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  cleanupPids.clear();
});

afterAll(() => rm(tempRoot, { recursive: true, force: true }));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("end-to-end: coforge proc start survives daemon stop, appears in computer status, and stops on computer stop --jobs", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;

  const coordStateDir = join(tempRoot, "state");
  const installDir = join(tempRoot, "install");
  const workspaceRoot = join(tempRoot, "workspaces");
  const workspaceId = "ws-e2e";
  const workspaceStateDir = workspaceStateDirectory(coordStateDir, workspaceId);
  const procConfigDirectory = join(tempRoot, "computer");
  const procMemoryConfigPath = join(procConfigDirectory, "proc.json");
  await mkdir(join(workspaceRoot, workspaceId, "agents", "agent-a"), { recursive: true });
  await mkdir(installDir, { recursive: true });

  const connection: DaemonConfig = {
    computerId: "comp-e2e",
    workspaceId,
    workspaceRoot,
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(workspaceId, "comp-e2e", "daemon-token");

  const agentApiKey = `sk_agent_${"a".repeat(43)}`;
  let runtime!: DaemonRuntime;
  const proxy = startAgentProxy({
    runtime: daemonAgentProxyRuntime(() => runtime),
  });
  const buildRuntime = () =>
    new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({
          async sendMessage() {},
          subscribe: () => () => undefined,
          async interrupt() {},
          onExit: () => () => undefined,
          async dispose() {},
        }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return agentApiKey;
          },
          async revokeAgentApiKey() {},
        }),
      },
      proxy,
      {
        async list() {
          return [];
        },
      } as never,
      workspaceStateDir,
      { procMemoryConfigPath },
    );
  runtime = buildRuntime();

  let jobPid = 0;
  try {
    await runtime.start(connection);
    const config: AgentRuntimeConfig = {
      provider: "pi",
      model: "default",
      modelProvider: "anthropic",
      reasoning: "balanced",
    };
    await runtime.startAgent("agent-a", config);
    const context = proxy.issue("agent-a", agentApiKey);
    const transport = connectLocal("", context, proxy.url);

    const startOut = (await run(
      [
        "proc",
        "start",
        "--name",
        "dev-srv",
        "--",
        process.execPath,
        "-e",
        "console.log('E2E_READY'); setInterval(() => {}, 1000);",
      ],
      transport,
    )) as string;
    expect(startOut).toContain("Started background job dev-srv");

    const listJson = decodeAgentProcListResponse(
      JSON.parse((await run(["proc", "list", "--json"], transport)) as string),
    );
    expect(listJson.jobs).toHaveLength(1);
    const hardScope = await createProcJobMemoryScopeDetector(process.platform)();
    expect(listJson.jobs[0]?.memory).toMatchObject({
      mode: hardScope ? "systemd_cgroup" : "process_group_rss",
      limitBytes: 4096 * 1024 * 1024,
    });
    const listOut = (await run(["proc", "list"], transport)) as string;
    expect(listOut).toMatch(/memory=(process-group RSS sampling|systemd cgroup hard limit)/);
    jobPid = listJson.jobs[0]!.pid;
    cleanupPids.add(jobPid);
    expect(pidAlive(jobPid)).toBe(true);

    let logsJson = decodeAgentProcLogsResponse(
      JSON.parse(
        (await run(["proc", "logs", "dev-srv", "--tail", "10", "--json"], transport)) as string,
      ),
    );
    for (let i = 0; i < 40 && !logsJson.content.includes("E2E_READY"); i++) {
      await Bun.sleep(25);
      logsJson = decodeAgentProcLogsResponse(
        JSON.parse(
          (await run(["proc", "logs", "dev-srv", "--tail", "10", "--json"], transport)) as string,
        ),
      );
    }
    expect(logsJson.content).toContain("E2E_READY");
    expect(logsJson.job.memory?.limitBytes).toBe(4096 * 1024 * 1024);

    await mkdir(procConfigDirectory, { recursive: true });
    await Bun.write(procMemoryConfigPath, '{"memoryMaxMb":-1}');
    const nextCommand = [
      "proc",
      "start",
      "--name",
      "uncapped",
      "--json",
      "--",
      process.execPath,
      "-e",
      "await Bun.sleep(10000)",
    ];
    await expect(run(nextCommand, transport)).rejects.toThrow(
      "Invalid or unreadable Computer proc memory configuration",
    );
    await Bun.write(procMemoryConfigPath, '{"memoryMaxMb":0}');
    const uncapped = decodeAgentProcStartResponse(
      JSON.parse((await run(nextCommand, transport)) as string),
    );
    cleanupPids.add(uncapped.job.pid);
    expect(uncapped.job.memory).toBeUndefined();
    await run(["proc", "stop", "uncapped", "--force"], transport);

    await runtime.stop();
    expect(pidAlive(jobPid)).toBe(true);
    runtime = buildRuntime();
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const adoptedContext = proxy.issue("agent-a", agentApiKey);
    const adoptedTransport = connectLocal("", adoptedContext, proxy.url);
    const adopted = decodeAgentProcListResponse(
      JSON.parse((await run(["proc", "list", "--json"], adoptedTransport)) as string),
    );
    expect(adopted.jobs.find((job) => job.pid === jobPid)).toMatchObject({
      status: "running",
      memory: { limitBytes: 4096 * 1024 * 1024 },
    });
    await runtime.stop();
    proxy.close();

    const status = await collectComputerStatus(
      createStatusPorts({
        platform: process.platform,
        installDirectory: installDir,
        stateDirectory: coordStateDir,
        releaseFeedUrl: "https://releases.coforge.cn/",
        serverUrl: "https://coforge.cn",
        registrations: {
          listRegistrations: async () => [{ id: workspaceId, slug: "e2e" } as never],
        },
      }),
    );
    expect(status.procJobs).toBeDefined();
    expect(status.procJobs?.supported).toBe(true);
    expect(status.procJobs?.jobs[0]?.memory?.limitBytes).toBe(4096 * 1024 * 1024);
    expect(status.procJobs?.jobs[0]).not.toHaveProperty("command");
    expect(status.procJobs?.jobs[0]).not.toHaveProperty("cwd");
    expect(status.procJobs?.jobs[0]).not.toHaveProperty("logPath");
    expect(status.procJobs?.jobs.map((job) => ({ name: job.name, pid: job.pid }))).toEqual([
      { name: "dev-srv", pid: jobPid },
    ]);

    const stopOutput: string[] = [];
    await stopComputer(
      {
        async assertRestartable() {
          throw new Error("not installed");
        },
        async stop() {},
        async isRunning() {
          return false;
        },
        listRunningProcJobs: () => listMachineRunningProcJobs(coordStateDir),
        stopProcJobs: () => stopMachineRunningProcJobs(coordStateDir, { force: true }),
      },
      { stdout: (line) => stopOutput.push(line) },
      { json: true, jobs: true },
    );

    expect(JSON.parse(stopOutput[0]!)).toEqual({
      ok: true,
      stopped: false,
      stoppedProcJobs: 1,
      failedProcJobs: 0,
    });
    expect(pidAlive(jobPid)).toBe(false);
    expect(await listMachineRunningProcJobs(coordStateDir)).toEqual([]);
  } finally {
    await runtime.stop().catch(() => {});
    proxy.close();
  }
});
